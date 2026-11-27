import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { authorizeProjectReference, listProjectAssets, readAsset, verifyAssetSource, verifySourceAuthorization } from './assets.js'
import { dateMillis, probeConversation, readProjectHistory, readSourceEvents, scanProjects } from './projects.js'
import {
  approveConversation, discardConversation, finishConversation, firstContinuationMessage, locateHistoryMessage, locateRelayExcerpt,
  readCompletedConversationImports, readContextExcerpts, readConversationSnapshot, readHistoryPage,
  readPendingConversation, readRetainedRelaySnapshot, rebindConversation, setConversationAttempt, stageConversation, withApprovedImportLock,
} from './conversation-store.js'
import { searchConversations } from './conversation-search.js'
import { createSourceMonitor } from './watch.js'
import { makeExport } from './export.js'
import { readConversationAttachment } from './history-attachment.js'
import {
  canReadConversation, conversationIds, conversationTitle, keyFor, makePrompt, mergeProjects, pathKey, redact,
} from './handoff.js'
import { countTrace, isSessionId, normalizeTrace } from './session-trace.js'
import { isMarkdownFile, relativeMarkdownLinks } from '../web/markdown.js'
import { relayCategories } from '../web/relay-categories.js'
import {
  ProjectArchiveError, readProjectSelection, readProjectState, writeProjectArchive,
  writeProjectContinuation, writeProjectPin, writeProjectSelection,
  readProjectRelay, changeProjectRelay, saveCodexAliases,
} from './project-archive.js'

export { canReadConversation, conversationId, conversationTitle, makePrompt, mergeProjects, pathKey, redact } from './handoff.js'

const run = promisify(execFile)
const fallbackScanInterval = 15_000
const ticketLifetime = 10 * 60_000
const catalogId = /^[0-9a-f]{24}$/
const traceBudget = { items: 200, bytes: 48 * 1024, resultBytes: 4 * 1024 }

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

async function gitStatus(cwd) {
  try {
    const { stdout } = await run('git', [
      '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, 'status', '--short',
      '--branch', '--untracked-files=normal', '--ignore-submodules=all',
    ], { timeout: 2500, maxBuffer: 128 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    return stdout.trim()
  } catch {
    return ''
  }
}

function publicProject({ archives, ...project }) {
  return { ...project, sessions: archives.length, hasConversations: archives.some(canReadConversation) }
}

// Source trace is shown to the user and stored with the imported session, so
// it is bounded and redacted exactly once here. Results are shortened before
// items are dropped so a long build log cannot hide the surrounding calls.
function limitUtf8(text, bytes) {
  const data = Buffer.from(text, 'utf8')
  if (data.length <= bytes) return text
  while ((data[bytes] & 0xc0) === 0x80) bytes--
  return data.toString('utf8', 0, bytes)
}

export function conversationTrace(trace, messageCount, offset = 0) {
  const items = []
  const seen = new Set()
  let bytes = 2 // JSON array brackets
  let truncated = false
  const indexOf = new Map()
  for (const item of [...trace].reverse()) {
    const index = Number.isInteger(item?.messageIndex) ? item.messageIndex - offset : undefined
    // Records are shown under the question they belong to. One without a
    // retained message, or whose message fell out of the window, cannot be
    // placed anywhere the user can see, so it is dropped.
    if (index === undefined || index < 0 || index >= messageCount) {
      truncated = true
      continue
    }
    const text = redact(item?.text ?? '')
    const bounded = limitUtf8(text, item?.kind === 'tool_result' ? traceBudget.resultBytes : 2000)
    const [entry] = normalizeTrace([{
      ...item,
      name: item.name ? redact(item.name) : undefined,
      text: bounded,
      truncated: text !== bounded || item.truncated === true,
      messageIndex: index,
    }])
    if (!entry || seen.has(entry.id)) continue
    const cost = Buffer.byteLength(JSON.stringify(entry)) + (items.length ? 1 : 0)
    if (items.length >= traceBudget.items || bytes + cost > traceBudget.bytes) {
      truncated = true
      continue
    }
    seen.add(entry.id)
    bytes += cost
    truncated ||= entry.truncated === true
    items.unshift(entry)
    indexOf.set(index, [entry.id, ...(indexOf.get(index) ?? [])])
  }
  return { trace: items, indexOf, truncated }
}

async function currentDirectory(cwd) {
  try {
    const canonical = await realpath(cwd)
    if ((await stat(canonical)).isDirectory()) return canonical
  } catch {
    // Historical sources may point to an offline drive or a removed worktree.
  }
  return null
}

async function conversationDirectory(cwd) {
  if (typeof cwd !== 'string' || cwd.length > 4096 || !path.isAbsolute(cwd) || /[\u0000-\u001f]/u.test(cwd)) return
  const canonical = await currentDirectory(cwd)
  if (!canonical || canonical === path.parse(canonical).root) return
  const info = await stat(canonical, { bigint: true }).catch(() => undefined)
  if (info?.isDirectory()) return { path: canonical, identity: `${info.dev}:${info.ino}` }
}

function hasUnwrittenAttempt(record, state) {
  return record?.state === 'approved' && !record.seed && record.importAttempt === state
}

function sortProjects(a, b) {
  return Number(b.online) - Number(a.online)
    || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    || a.name.localeCompare(b.name, 'zh-CN')
}

function applyProjectState(projects, { archivedIds, preferences }) {
  const visibleState = []
  for (const project of projects) {
    const preference = preferences.get(project.id)
    project.archived = archivedIds.has(project.id)
    project.pinned = preference?.pinned ?? false
    project.continuedAt = preference?.continuedAt ?? null
    if (project.archived || project.pinned || project.continuedAt !== null) {
      visibleState.push([project.id, project.archived, project.pinned, project.continuedAt])
    }
  }
  return keyFor(visibleState.sort((a, b) => a[0].localeCompare(b[0])))
}

function storageFailure(operation, error, subject = '项目归档记录') {
  const sqliteCode = error.errcode & 0xff
  let detail = '请检查 agent-bridge-archive.sqlite 及其所在目录。'
  if (error instanceof ProjectArchiveError) detail = error.message
  else if ([5, 6].includes(sqliteCode)) detail = '归档数据库正忙，请重试。'
  else if ([11, 26].includes(sqliteCode)) detail = '归档文件已损坏或格式无效。'
  else if ([3, 8, 14].includes(sqliteCode) || ['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
    detail = '请检查归档文件和目录的访问权限。'
  }
  return new RequestError(`无法${operation}${subject}。${detail}`, 503)
}

async function loadProjectState(config) {
  try { return await readProjectState(config) }
  catch (error) { throw storageFailure('读取', error, '项目归档和偏好记录') }
}

function isCatalogId(id) {
  return typeof id === 'string' && catalogId.test(id)
}

function requireProject(current, projectId) {
  const project = current.projects.find(item => item.id === projectId)
  if (!project) throw new RequestError('项目目录已刷新，请重新选择项目。', 404)
  return project
}

export function createCatalog(loadConfig, { importConversation, canOpenConversation = () => true, skillHandoff, loadSourceRecord } = {}) {
  let snapshot
  let scanning
  let revision = 0
  let epoch = 0
  let disposed = false
  const details = new Map()
  const signatures = new Map()
  const skillDetailRevisions = new Map()
  const tickets = new Map()
  const openReferences = new Map()
  const conversationTickets = new Map()
  const sourceIndexes = new WeakMap()
  const watched = new Map()
  const listeners = new Set()
  const monitor = createSourceMonitor({ onChange() {
    epoch++
    wake()
  } })

  function wake() {
    for (const listener of listeners) listener()
  }

  function waitForChange(knownRevision) {
    if (knownRevision !== revision || snapshot?.epoch !== epoch || listeners.size >= 32 || disposed) return
    return new Promise(resolve => {
      function done() {
        clearTimeout(timer)
        listeners.delete(done)
        resolve()
      }
      const timer = setTimeout(done, 5_000)
      listeners.add(done)
    })
  }

  async function synchronizeProjectState() {
    if (scanning) await scanning
    const current = snapshot
    const state = await loadProjectState(current.config)
    if (scanning || snapshot !== current) return synchronizeProjectState()
    const stateFingerprint = applyProjectState(current.projects, state)
    if (current.stateFingerprint !== stateFingerprint) {
      current.stateFingerprint = stateFingerprint
      revision++
      wake()
    }
    return current
  }

  async function scan(refresh = false) {
    if (scanning) return scanning
    if (!refresh && snapshot?.epoch === epoch && Date.now() - snapshot.scannedAt < fallbackScanInterval) {
      return synchronizeProjectState()
    }
    scanning = (async () => {
      const scanEpoch = epoch
      const config = await loadConfig()
      const result = await scanProjects(config)
      const resolved = new Map()
      const aliases = [...new Set(result.projects.map(item => item.cwd))]
      for (let i = 0; i < aliases.length; i += 64) {
        await Promise.all(aliases.slice(i, i + 64).map(async cwd => resolved.set(cwd, await currentDirectory(cwd))))
      }
      const projects = mergeProjects(result.projects.map(item => ({ ...item, cwd: resolved.get(item.cwd) || item.cwd })))
      const online = new Set([...resolved.values()].filter(Boolean).map(value => pathKey(value)))
      for (const project of projects) {
        project.online = online.has(pathKey(project.cwd))
        if (watched.has(project.cwd)) watched.set(project.cwd, { cwd: project.cwd, projectIds: project.projectIds, archives: project.archives })
      }
      projects.sort(sortProjects)
      const fingerprint = keyFor(projects, result.sources)
      const stateFingerprint = applyProjectState(projects, await loadProjectState(config))
      const changed = refresh || snapshot?.epoch !== scanEpoch || snapshot?.fingerprint !== fingerprint
        || snapshot?.stateFingerprint !== stateFingerprint
      details.clear()
      snapshot = { config, projects, sources: result.sources, scannedAt: Date.now(), fingerprint, stateFingerprint, epoch: scanEpoch, conversationLists: new Map() }
      await monitor.update(config, [...watched.values()])
      if (changed) {
        revision++
        wake()
      }
      return snapshot
    })().finally(() => { scanning = undefined })
    return scanning
  }

  async function setProjectArchive(input) {
    if (typeof input.archived !== 'boolean' || !Array.isArray(input.projectIds) || !input.projectIds.length
      || !input.projectIds.every(isCatalogId)) {
      throw new RequestError('归档请求格式无效，请重新选择项目。')
    }
    const projectIds = [...new Set(input.projectIds)]
    const current = await scan()
    const known = new Set(current.projects.map(project => project.id))
    if (projectIds.some(id => !known.has(id))) throw new RequestError('有项目已不在当前目录中，请刷新后重试。', 404)
    let changedProjectIds
    try { changedProjectIds = await writeProjectArchive(current.config, projectIds, input.archived) }
    catch (error) { throw storageFailure('保存', error) }
    await synchronizeProjectState()
    return { projectIds, changedProjectIds, archived: input.archived, revision }
  }

  async function setProjectPin({ projectId, pinned }) {
    if (!isCatalogId(projectId) || typeof pinned !== 'boolean') throw new RequestError('置顶请求格式无效。')
    const current = await scan()
    requireProject(current, projectId)
    try { await writeProjectPin(current.config, projectId, pinned) }
    catch (error) { throw storageFailure('保存', error, '项目置顶') }
    await synchronizeProjectState()
    return { projectId, pinned, revision }
  }

  async function setProjectSelection({ projectId, assetIds, history }) {
    if (!isCatalogId(projectId) || typeof history !== 'boolean'
      || !Array.isArray(assetIds) || assetIds.length > 24 || !assetIds.every(isCatalogId)) {
      throw new RequestError('资料选择格式无效，每个项目最多记住 24 项。')
    }
    const current = snapshot ?? await scan()
    requireProject(current, projectId)
    const selection = { assetIds: [...new Set(assetIds)], history }
    try { await writeProjectSelection(current.config, projectId, selection) }
    catch (error) { throw storageFailure('保存', error, '项目资料选择') }
    return { projectId, selection }
  }

  async function recordProjectContinuation(id) {
    const ticket = getTicket(id)
    if (!ticket.opened) throw new RequestError('请先打开交接草稿，再记录接续。', 409)
    ticket.continuation ??= writeProjectContinuation(ticket.config, ticket.projectId).catch(error => {
      delete ticket.continuation
      throw storageFailure('保存', error, '项目接续记录')
    })
    const continuedAt = await ticket.continuation
    await synchronizeProjectState()
    return { projectId: ticket.projectId, continuedAt, revision }
  }

  async function detail(id) {
    const current = await scan()
    const { config } = current
    const project = requireProject(current, id)
    if (skillHandoff?.revision) {
      try {
        const skillRevision = await skillHandoff.revision()
        if (skillDetailRevisions.get(id) !== skillRevision) {
          skillDetailRevisions.set(id, skillRevision)
          if (details.has(id)) {
            details.delete(id)
            signatures.delete(id)
            revision++
            wake()
          }
        }
      } catch { /* The text-only path remains available without a skill service. */ }
    }
    if (details.has(id)) return details.get(id)
    const pending = (async () => {
      if (!watched.has(project.cwd)) {
        if (watched.size >= 4) watched.delete(watched.keys().next().value)
        watched.set(project.cwd, { cwd: project.cwd, projectIds: project.projectIds, archives: project.archives })
        await monitor.update(config, [...watched.values()])
      }
      const [{ memories, skills }, history] = await Promise.all([
        listProjectAssets(project, config),
        readProjectHistory(project, config),
      ])
      const used = new Set(history.usedSkills.map(name => name.toLowerCase()))
      const normalize = (item, kind) => ({
        ...item, kind, id: keyFor(kind, item.file, item.agent, item.scope),
        used: kind === 'skill' && used.has(item.name.toLowerCase()),
      })
      const normalizedSkills = skills.map(item => normalize(item, 'skill'))
      const inspected = skillHandoff
        ? await skillHandoff.inspect(project, normalizedSkills)
        : {
            available: false,
            projectRoot: undefined,
            skills: Object.fromEntries(normalizedSkills.map(item => [item.id, {
              label: '仅可带入说明',
              state: 'handoff',
              action: 'view',
              allowed: false,
              current: false,
              sourceChanged: false,
              reason: '当前 DSH 未提供原生技能服务。',
            }])),
          }
      for (const item of normalizedSkills) {
        if (inspected.skills[item.id]) item.handoff = inspected.skills[item.id]
      }
      const result = {
        project, history, config,
        memories: memories.map(item => normalize(item, 'memory')),
        skills: normalizedSkills,
        skillNativeAvailable: inspected.available,
        skillProjectRoot: inspected.projectRoot,
        managedSkills: inspected.managedSkills ?? [],
      }
      if (current === snapshot) {
        const assets = [...result.memories, ...result.skills].map(item => [publicAsset(item), item.revision])
        const signature = keyFor(assets, result.managedSkills, history)
        if (signatures.has(id) && signatures.get(id) !== signature) {
          revision++
          wake()
        }
        if (!signatures.has(id) && signatures.size >= 24) signatures.delete(signatures.keys().next().value)
        signatures.set(id, signature)
      }
      return result
    })().catch(error => {
      if (details.get(id) === pending) details.delete(id)
      throw error
    })
    if (details.size >= 24) details.delete(details.keys().next().value)
    details.set(id, pending)
    return pending
  }

  function publicAsset({ id, name, agent, scope, detail, file, used, handoff }) {
    return { id, name, agent, scope, detail, file, used, ...(handoff ? { handoff } : {}) }
  }

  async function prepare(input) {
    const entry = await detail(input.projectId)
    const current = await currentDirectory(entry.project.cwd)
    const canImport = Boolean(current && pathKey(current) === pathKey(entry.project.cwd))
    if (!Array.isArray(input.assetIds) || input.assetIds.length > 24 || input.assetIds.some(id => typeof id !== 'string')) {
      throw new RequestError('每次交接最多选择 24 项记忆和 Skills。')
    }
    const selected = new Set(input.assetIds)
    const assets = [...entry.memories, ...entry.skills].filter(item => selected.has(item.id))
    if (assets.length !== selected.size) throw new RequestError('所选资料已变化，请刷新项目。', 409)
    if (input.nativeSkillIds !== undefined && (!Array.isArray(input.nativeSkillIds)
      || input.nativeSkillIds.length > 8
      || input.nativeSkillIds.some(id => typeof id !== 'string' || !selected.has(id)))) {
      throw new RequestError('已启用技能选择格式无效。')
    }
    const nativeSkillIds = new Set(input.nativeSkillIds ?? [])
    const nativeAssets = assets.filter(item => item.kind === 'skill' && nativeSkillIds.has(item.id))
    if (nativeAssets.length !== nativeSkillIds.size) {
      throw new RequestError('已启用技能必须同时属于本次资料选择。')
    }
    let nativeApprovals = []
    if (nativeAssets.length) {
      if (!skillHandoff?.authorizeTextOmission) {
        throw new RequestError('当前 DSH 无法确认技能的原生登记状态。', 409)
      }
      nativeApprovals = await skillHandoff.authorizeTextOmission(entry.project, nativeAssets)
    }
    const sectionAssets = assets.filter(item => !(item.kind === 'skill' && nativeSkillIds.has(item.id)))
    const sections = await Promise.all(sectionAssets.map(async item => {
      const result = await readAsset(item).catch(() => {
        throw new RequestError(`无法读取「${item.name}」。请刷新后重试。`, 409)
      })
      return {
        label: `${item.kind === 'memory' ? '记忆' : 'Skill'} · ${item.name}（${item.agent}）`,
        file: item.file, assetId: item.id, ...result,
        handoff: assets.length === 1 && (item.agent === 'export' || item.detail === '项目交接'),
      }
    }))
    if (nativeAssets.length) {
      const approved = new Map(nativeApprovals.map(item => [item.assetId, item]))
      sections.unshift({
        label: '已启用 Skill',
        text: `${nativeAssets.map(item => {
          const name = item.handoff?.dshName || item.name
          return approved.get(item.id)?.invocation?.modelInvocable === false ? `${name}（仅手动）` : name
        }).join('、')} 已由 DSH 原生技能目录提供；按需调用，不在此重复正文。`,
      })
    }
    let historyTrace
    if (input.history === true) {
      const retained = entry.history.messages.slice(-8)
      const offset = entry.history.messages.length - retained.length
      for (const message of retained) {
        if (message.role !== 'user' && message.role !== 'assistant') continue
        const author = message.role === 'user' ? '用户' : '助手'
        sections.push({
          label: [`近期会话 · ${author}`, message.agent].filter(Boolean).join(' · '),
          text: message.text, conversation: true, markdown: message.role === 'assistant',
        })
      }
      // The draft only carries the last few turns, so the trace is trimmed to
      // the same window and re-indexed before it reaches the export preview.
      historyTrace = conversationTrace(entry.history.trace ?? [], retained.length, offset).trace
    }
    const { prompt, truncated, preview } = makePrompt(entry.project, sections, canImport ? await gitStatus(current) : '')
    for (const section of preview.sections) {
      if (!isMarkdownFile(section.file)) continue
      const asset = sectionAssets.find(item => item.id === section.assetId)
      if (asset) section.references = await markdownReferences(entry, asset, section.text)
    }
    if (historyTrace?.length) preview.trace = historyTrace
    for (const [key, value] of tickets) {
      if (Date.now() - value.created > ticketLifetime) tickets.delete(key)
    }
    if (tickets.size >= 40) tickets.delete(tickets.keys().next().value)
    const ticket = randomUUID()
    tickets.set(ticket, {
      created: Date.now(), path: canImport ? current : null, prompt, truncated, title: entry.project.name,
      projectId: entry.project.id, config: entry.config, preview,
    })
    const skillCandidates = entry.skills.filter(item => selected.has(item.id)).map(item => ({
      assetId: item.id,
      ...item.handoff,
    }))
    return { ticket, prompt, truncated, canImport, preview, skillCandidates }
  }

  function getTicket(id) {
    const ticket = tickets.get(id)
    if (!ticket || Date.now() - ticket.created > ticketLifetime) throw new RequestError('预览已过期，请重新生成。', 409)
    return ticket
  }

  async function markdownReferences(entry, asset, text) {
    const hrefs = relativeMarkdownLinks(text).slice(0, 128)
    if (!hrefs.length) return []
    const root = await currentDirectory(entry.project.cwd)
    if (!root || pathKey(root) !== pathKey(entry.project.cwd)) return []
    const references = await Promise.all(hrefs.map(async href => {
      const { path: target, authorization, error, revealOnly } = await authorizeProjectReference(root, asset.file, href)
      if (!authorization) return { href, path: target, error }
      const id = randomUUID()
      if (openReferences.size >= 2048) openReferences.delete(openReferences.keys().next().value)
      openReferences.set(id, { projectId: entry.project.id, asset, authorization, revealOnly, created: Date.now() })
      return { href, path: target, id }
    }))
    return references
  }

  function getOpenReference(id, projectId) {
    const reference = openReferences.get(id)
    if (!reference || reference.projectId !== projectId || Date.now() - reference.created > ticketLifetime) {
      throw new RequestError('文件链接已失效，请重新打开预览。', 409)
    }
    return reference
  }

  async function verifyOpenReference(reference, current) {
    if (!current || pathKey(current) !== pathKey(reference.authorization.root)) {
      throw new RequestError('项目目录已移动或不可访问。', 409)
    }
    try {
      await verifyAssetSource(reference.asset)
      const target = await verifySourceAuthorization(reference.authorization)
      return { path: target.file, kind: 'file', name: path.basename(target.file), revealOnly: reference.revealOnly }
    } catch {
      throw new RequestError('链接文件已移动、被替换或不在项目范围内。', 409)
    }
  }

  async function exportPreview(ticket) {
    const current = ticket.path && await currentDirectory(ticket.path)
    if (!current) return ticket.preview
    const sections = await Promise.all(ticket.preview.sections.map(async section => {
      if (!section.references?.length) return section
      const references = await Promise.all(section.references.map(async reference => {
        if (!reference.id) return reference
        try {
          const grant = getOpenReference(reference.id, ticket.projectId)
          const target = await verifyOpenReference(grant, current)
          if (!target.revealOnly) return { ...reference, verifiedFile: target.path }
        } catch { /* A stale reference is exported as text. */ }
        return reference
      }))
      return { ...section, references }
    }))
    return { ...ticket.preview, sections }
  }

  // The panel never supplies a free-form path for opening. It names an asset
  // that is currently listed for the project (or the project directory
  // itself), and the host re-reads the recorded authorization so a replaced
  // file, a junction, or a moved source is refused instead of opened.
  async function resolveOpenPath(input) {
    const entry = await detail(input.projectId)
    if (input.referenceId !== undefined) {
      const reference = getOpenReference(input.referenceId, entry.project.id)
      const current = await currentDirectory(entry.project.cwd)
      return verifyOpenReference(reference, current)
    }
    if (input.directory === true) {
      const current = await currentDirectory(entry.project.cwd)
      if (!current || pathKey(current) !== pathKey(entry.project.cwd)) {
        throw new RequestError('项目目录已移动或不可访问。', 409)
      }
      return { path: current, kind: 'directory', name: entry.project.name }
    }
    if (typeof input.assetId !== 'string' || !isCatalogId(input.assetId)) {
      throw new RequestError('资料标识无效。')
    }
    const item = [...entry.memories, ...entry.skills].find(asset => asset.id === input.assetId)
    if (!item) throw new RequestError('找不到所选资料，请刷新项目。', 404)
    let source
    try {
      source = await verifyAssetSource(item)
    } catch {
      throw new RequestError('资料已移动或内容已变化，请刷新项目后重试。', 409)
    }
    return { path: source.file, kind: 'file', name: item.name }
  }

  function conversationSources(project) {
    if (sourceIndexes.has(project)) return sourceIndexes.get(project)
    const archives = project.archives
      .filter(canReadConversation)
      .sort((a, b) => dateMillis(b.date) - dateMillis(a.date))
    const current = new Map()
    const aliases = new Map()
    for (const archive of archives) {
      const [id, ...oldIds] = conversationIds(archive)
      if (!current.has(id)) current.set(id, { id, ids: [id], archive })
      const source = current.get(id)
      for (const alias of oldIds) {
        if (!aliases.has(alias)) aliases.set(alias, source)
        else if (aliases.get(alias) !== source) aliases.set(alias, null)
      }
    }
    const byId = new Map(current)
    for (const [alias, source] of aliases) {
      if (!source || byId.has(alias)) continue
      source.ids.push(alias)
      byId.set(alias, source)
    }
    const index = { current: [...current.values()], byId }
    sourceIndexes.set(project, index)
    return index
  }

  function sourceFor(project, id) {
    return (project && conversationSources(project).byId.get(id)) ?? { id, ids: [id] }
  }

  async function rememberLegacyLinks(config, projectId, links) {
    const verified = links.filter(([source, alias]) =>
      source.archive?.profile && source.id !== alias && !source.archive.savedIds?.includes(alias))
    if (!verified.length) return
    // A read-only installation can still use the currently verified filesystem links.
    try { await saveCodexAliases(config, projectId, verified) } catch { return }
    for (const [source, alias] of verified) {
      const saved = source.archive.savedIds ??= []
      if (!saved.includes(alias)) saved.push(alias)
    }
  }

  async function readableConversations(project, config) {
    const candidates = conversationSources(project).current
    const sessions = []
    for (let offset = 0; offset < candidates.length; offset += 8) {
      const batch = await Promise.all(candidates.slice(offset, offset + 8).map(async ({ id, archive }) => {
        const probe = await probeConversation(archive, { sourceCwd: project.cwd, config })
        if (probe.state === 'empty') return undefined
        return {
          id, agent: archive.agent ?? archive.kind, date: dateMillis(archive.date),
          title: conversationTitle(archive.title), archivedSource: archive.kind === 'agentsview',
          ...(probe.state === 'unknown' ? { unavailable: true, reason: probe.reason } : {}),
        }
      }))
      sessions.push(...batch.filter(Boolean))
    }
    return sessions
  }

  async function loadImportStates(config, projectId, sources) {
    const owners = new Map()
    for (const source of sources) for (const alias of source.ids) owners.set(alias, source)
    const grouped = new Map()
    const entries = await readCompletedConversationImports(config, projectId, [...owners.keys()])
    await rememberLegacyLinks(config, projectId, entries.map(entry => [owners.get(entry.sourceId), entry.sourceId]))
    for (const entry of entries) {
      const { id } = owners.get(entry.sourceId)
      if (!grouped.has(id)) grouped.set(id, [])
      grouped.get(id).push(entry)
    }
    return new Map(await Promise.all([...grouped].map(async ([sourceId, entries]) => {
      const [latest] = entries
      const unavailableImports = []
      let sessionId = null
      for (const entry of entries) {
        if (await canOpenConversation(entry.sessionId)) {
          sessionId = entry.sessionId
          break
        }
        unavailableImports.push(entry.sessionId)
      }
      return [sourceId, { unavailableImports, lastImport: {
        sessionId, importedAt: latest.importedAt, approximate: Boolean(latest.approximate),
        ...(sessionId && sessionId !== latest.sessionId ? { older: true } : {}),
      } }]
    })))
  }

  async function withImportStates(config, project, sessions) {
    const sources = [...new Set(sessions.map(session => session.id))].map(id => sourceFor(project, id))
    const states = await loadImportStates(config, project.id, sources)
    return sessions.map(session => {
      const state = states.get(session.id)
      return state ? { ...session, lastImport: state.lastImport } : session
    })
  }

  async function importStatus(config, projectId, source) {
    return (await loadImportStates(config, projectId, [source])).get(source.id)
  }

  async function listConversations(projectId, recent, cursor) {
    const current = await scan()
    const project = requireProject(current, projectId)
    const { conversationLists, config } = current
    if (!conversationLists.has(projectId)) {
      conversationLists.set(projectId, readableConversations(project, config))
    }
    const sessions = await conversationLists.get(projectId)
    const ready = sessions.filter(session => !session.unavailable)
    const unavailable = sessions.filter(session => session.unavailable)
    if (recent) return { sessions: await withImportStates(config, project, ready.slice(0, 3)), total: ready.length,
      ...(unavailable.length ? { unavailable: unavailable.slice(0, 20) } : {}) }
    const marker = keyFor(ready.map(({ id }) => id))
    const parsed = typeof cursor === 'string' && /^([0-9a-f]{24}):(\d{1,9})$/.exec(cursor)
    if (cursor && (!parsed || parsed[1] !== marker)) throw new RequestError('会话列表已更新，请从第一页重新打开。', 409)
    const offset = parsed ? Number(parsed[2]) : 0
    const end = offset + 100
    return { sessions: await withImportStates(config, project, ready.slice(offset, end)),
      ...(end < ready.length ? { nextCursor: `${marker}:${end}` } : {}),
      ...(!offset && unavailable.length ? { unavailable: unavailable.slice(0, 100) } : {}) }
  }

  async function previewConversation({ projectId, sessionId, targetCwd, snapshotId, searchHit, relayId, inspectSource, duplicate, signal }, recover = false) {
    if (!isCatalogId(sessionId)) throw new RequestError('会话标识无效。')
    if (snapshotId !== undefined && !isSessionId(snapshotId)) throw new RequestError('会话预览凭据无效，请重新打开。', 409)
    if (searchHit && (!Number.isSafeInteger(searchHit.turn) || searchHit.turn < 1
      || !Number.isSafeInteger(searchHit.offset) || searchHit.offset < 0 || !isCatalogId(searchHit.hash))) {
      throw new RequestError('搜索结果位置无效。')
    }
    const current = await scan()
    const project = requireProject(current, projectId)
    const { config } = current
    const source = sourceFor(project, sessionId)
    sessionId = source.id
    const relay = relayId && (await readProjectRelay(config, projectId)).find(item =>
      item.id === relayId && source.ids.includes(item.source.id))
    if (relayId && !relay) throw new RequestError('接力条目已移除。', 404)
    if (relay) await rememberLegacyLinks(config, projectId, [[source, relay.source.id]])
    const archive = source.archive
    const { lastImport } = await importStatus(config, projectId, source) ?? {}
    if (lastImport?.sessionId && !snapshotId && duplicate !== true && inspectSource !== true && !searchHit && !relay && targetCwd === undefined) {
      return { openExisting: true, lastImport, title: conversationTitle(archive?.title, 80) }
    }
    const saved = snapshotId && await readConversationSnapshot(config, snapshotId)
    if (recover && (targetCwd === undefined || !hasUnwrittenAttempt(saved, 'unwritten'))) {
      throw new RequestError('这次迁入无法改选目录，请从原凭据重试。', 409)
    }
    const previous = saved?.state === 'preview' || hasUnwrittenAttempt(saved, 'review') || recover ? saved : undefined
    const sameSource = saved && (source.ids.includes(saved.sourceId) || (!archive && saved.sourceIds?.includes(sessionId)))
    if ((snapshotId && (!saved || saved.projectId !== projectId || !sameSource))
      || (targetCwd !== undefined && snapshotId && !previous)) {
      throw new RequestError('会话预览已变化，请重新打开。', 409)
    }
    // An offline alternate directory still has a pending approval. A supplied snapshot or
    // explicit target must never select another receipt simply because it has the same source.
    let pending = saved?.state === 'approved' && !previous ? saved : undefined
    if (!snapshotId && targetCwd === undefined) {
      pending = await readPendingConversation(config, projectId, source.ids, project.cwd)
        ?? await readPendingConversation(config, projectId, source.ids)
    }
    const target = await conversationDirectory(targetCwd !== undefined ? targetCwd : pending?.targetCwd ?? saved?.targetCwd ?? project.cwd)
    if (targetCwd !== undefined && !target) throw new RequestError('目标目录不可访问，请选择本机工作目录。', 409)
    if (!snapshotId && targetCwd !== undefined) pending = await readPendingConversation(config, projectId, source.ids, target.path)
    const retained = !archive && relay && !snapshotId && await readRetainedRelaySnapshot(config, projectId, relay.source)
    if (!archive && !previous && !pending && !retained) throw new RequestError('找不到这条会话，请刷新项目。', 404)
    const metadata = {
      id: randomUUID(), sessionId: randomUUID(), projectId, sourceId: !archive && previous ? previous.sourceId : sessionId,
      sourceIds: [...new Set([...source.ids, ...(previous?.sourceIds ?? [])])],
      sourceCwd: previous?.sourceCwd ?? project.cwd, targetCwd: target?.path, targetIdentity: target?.identity,
      title: previous?.title ?? conversationTitle(archive?.title, 80),
    }
    let record = retained || pending || previous
    if (previous && targetCwd !== undefined) {
      if (previous.state === 'approved') {
        record = await withApprovedImportLock(config, previous.id, async () => {
          const rebound = await rebindConversation(config, previous, metadata, { approvedAttempt: previous.importAttempt })
          if (!rebound) throw new RequestError('迁入凭据已变化，请重新打开预览。', 409)
          return rebound
        })
      } else record = await rebindConversation(config, previous, metadata)
    } else if (!record) {
      record = await stageConversation(config, metadata, readSourceEvents(archive, { config, sourceCwd: project.cwd, signal }), redact,
        item => readConversationAttachment(project, archive, item))
    }
    if (!record) throw new RequestError('会话预览已变化，请重新打开。', 409)
    const messages = record.messages.map(({ role, text, time }) => ({ role, text, time }))
    if (messages.length) messages[0].text = firstContinuationMessage(record)
    const historyLocation = relay ? await locateRelayExcerpt(config, record.id, relay.source)
      : searchHit && await locateHistoryMessage(config, record.id, searchHit)
    const { trace, indexOf, truncated: traceTruncated } = conversationTrace(record.trace, messages.length)
    for (let index = 0; index < messages.length; index++) {
      if (indexOf.has(index)) messages[index].traceIds = indexOf.get(index)
    }
    const traceCounts = countTrace(trace)
    const { sourceStats, history } = record
    const title = record.title || conversationTitle(messages[0]?.text, 80) || '迁入的 Agent 会话'
    const canImport = Boolean(!retained && target && record.targetCwd && pathKey(record.targetCwd) === pathKey(target.path)
      && messages.length && record.targetIdentity === target.identity)
    const skillCandidates = skillHandoff
      && (!target || pathKey(target.path) === pathKey(project.cwd))
      ? await skillHandoff.conversationCandidates(project, record.usedSkills, (await detail(projectId)).skills)
      : []
    return {
      title, messages, ticket: canImport ? record.id : null, canImport, cwd: project.cwd,
      sourceCwd: record.sourceCwd ?? project.cwd, targetCwd: record.targetCwd, history,
      resumePending: !retained && record.state === 'approved' && !hasUnwrittenAttempt(record, 'review'),
      ...(!retained && hasUnwrittenAttempt(record, 'review') ? { continuationLocked: true } : {}),
      ...(!retained && hasUnwrittenAttempt(record, 'unwritten') ? { recoveryTicket: record.id } : {}),
      truncated: record.truncated || traceTruncated, skillCandidates, trace, traceCounts, sourceStats,
      ...(historyLocation ? { historyLocation } : searchHit ? { searchHitStale: true } : {}),
      ...(record.continuation ? { continuation: record.continuation } : {}),
      ...(lastImport ? { lastImport } : {}),
      ...(relay && (!historyLocation || historyLocation.changed) ? { relayLocationChanged: true } : {}),
    }
  }

  async function projectRelay(action, input) {
    const current = await scan()
    const { config } = current
    const project = requireProject(current, input.projectId)
    if (action === 'project-relay') {
      const items = await readProjectRelay(config, project.id)
      await rememberLegacyLinks(config, project.id, items.map(item => [sourceFor(project, item.source.id), item.source.id]))
      return { items }
    }
    if (action === 'export-relay') {
      const items = await readProjectRelay(config, project.id)
      if (!items.length) throw new RequestError('请先添加接力条目。', 409)
      const sections = Object.entries(relayCategories).map(([key, label]) => ({
        label, text: items.filter(item => item.category === key).map(({ text, source }) =>
          [`- 来源：${source.agent} · ${source.title} · 第 ${source.turn} 轮（会话 ${source.id}）`,
            '', ...text.split(/\r\n|\n|\r/).map(line => '> ' + line)].join('\n')).join('\n\n') || '暂无条目。',
      }))
      return makeExport({ title: redact(project.name) + ' · 项目接力单', format: 'share',
        preview: { cwd: project.cwd, sources: [...new Set(items.map(item => item.source.agent))], sections } })
    }
    if (action === 'remove-relay-item') {
      if (!isCatalogId(input.id)) throw new RequestError('接力条目标识无效。')
      await changeProjectRelay(config, project.id, input.id, () => null)
      return {}
    }
    if (!Object.hasOwn(relayCategories, input.category)) throw new RequestError('请选择接力分类。')
    if (action === 'update-relay-item') {
      if (!isCatalogId(input.id) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000) {
        throw new RequestError('接力正文须为 1 至 8,000 字符。')
      }
      return changeProjectRelay(config, project.id, input.id, previous => {
        if (!previous) throw new RequestError('接力条目已移除。', 404)
        return { ...previous, category: input.category, text: redact(input.text.trim()) }
      })
    }
    const { snapshotId, seq, offset } = input
    if (!isSessionId(snapshotId) || !Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new RequestError('来源摘录无效。')
    }
    const [excerpt] = await readContextExcerpts(config, project.id, [{ snapshotId, seq, offset }]) ?? []
    const origin = excerpt && sourceFor(project, excerpt.sourceId)
    if (!origin?.archive || !excerpt.turn) throw new RequestError('来源摘录已过期或没有可定位的回合。', 409)
    const source = { id: origin.id, title: excerpt.title || '未命名对话', agent: origin.archive.agent ?? origin.archive.kind,
      turn: excerpt.turn, kind: excerpt.kind, seq, offset, hash: keyFor(excerpt.text) }
    const [id, ...previousIds] = origin.ids.map(alias => keyFor(alias, source.turn, seq, offset, source.hash))
    return changeProjectRelay(config, project.id, id, previous => previous ?? {
      id, category: input.category, text: excerpt.text, source,
    }, previousIds)
  }

  async function reviewContinuation(record, config, excerpts = []) {
    if (!Array.isArray(excerpts) || excerpts.length > 8 || !excerpts.every(excerpt =>
      isSessionId(excerpt?.snapshotId) && Number.isSafeInteger(excerpt.seq) && excerpt.seq > 0
        && Number.isSafeInteger(excerpt.offset) && excerpt.offset >= 0)) {
      throw new RequestError('每次最多带入 8 段有效的来源摘录。')
    }
    const unique = [...new Map(excerpts.map(({ snapshotId, seq, offset }) =>
      [`${snapshotId}:${seq}:${offset}`, { snapshotId, seq, offset }])).values()]
    const items = unique.length ? await readContextExcerpts(config, record.projectId, unique) : []
    if (!items || items.some(item => !item)) throw new RequestError('部分摘录已过期或不属于当前项目，请重新勾选。', 409)
    const labels = { user: '用户', assistant: '助手', tool_call: '工具调用', tool_result: '工具结果', summary: '摘要' }
    const quoted = items.map(item => {
      const source = [item.title, item.turn && `第 ${item.turn} 轮`, labels[item.role ?? item.kind]].filter(Boolean).join(' · ')
      return `> ${source}\n>\n${item.text.split(/\r\n|\n|\r/u).map(line => `> ${line}`).join('\n')}`
    }).join('\n\n')
    if (quoted.length > 16_000) throw new RequestError('摘录合计超过 16,000 字符，请减少所选内容。')
    const firstMessage = record.messages[0].text + (quoted
      ? `\n\n以下是用户选入的历史摘录，请结合当前任务核对后使用。\n\n${quoted}` : '')
    return { contextKey: keyFor(record.id, unique, firstMessage), firstMessage, items }
  }

  async function previewContinuation({ ticket, excerpts }) {
    const config = await loadConfig()
    const record = await readConversationSnapshot(config, ticket)
    if (record?.state !== 'preview' || !record.messages.length) throw new RequestError('会话预览已过期，请重新打开。', 409)
    return reviewContinuation(record, config, excerpts)
  }

  async function writeApprovedConversation(config, ticket) {
    return withApprovedImportLock(config, ticket, async () => {
      const record = await readConversationSnapshot(config, ticket)
      if (record?.state === 'done') return { sessionId: record.sessionId }
      if (record?.state !== 'approved') throw new RequestError('迁入凭据已变化，请重新打开预览。', 409)
      const previouslyUnwritten = !record.seed && ['ready', 'unwritten', 'review'].includes(record.importAttempt)
      const target = await conversationDirectory(record.targetCwd)
      record.config = config
      record.title ||= conversationTitle(record.messages[0].text, 80) || '迁入的 Agent 会话'
      record.trace = conversationTrace(record.trace, record.messages.length).trace
      let result
      try {
        if (!target || pathKey(target.path) !== pathKey(record.targetCwd) || target.identity !== record.targetIdentity) {
          throw Object.assign(new RequestError('目标目录已变化，请核对原迁入目录。', 409), { nativeSessionUnwritten: true })
        }
        // Persist uncertainty before dispatch: a crash, timeout or older receipt must
        // never let a later pre-write failure authorize a second DSH session.
        if (!await setConversationAttempt(config, ticket, 'unknown')) throw new RequestError('迁入凭据已变化，请重新打开预览。', 409)
        result = await importConversation(record, target.path)
        await finishConversation(config, ticket, record.nativeTimeline)
      } catch (error) {
        const unwritten = previouslyUnwritten && error.nativeSessionUnwritten === true
        const message = unwritten ? 'DSH 尚未写入这条会话，可重试或改选目录。' : record.stored
          ? '会话历史已写入，暂时无法加入工作区。可重试打开。' : '无法确认 DSH 会话的写入结果，请在原目录重试。'
        const failure = error.status ? error : new RequestError(message, 503)
        if (unwritten && await setConversationAttempt(config, ticket, 'unwritten')) failure.recoveryTicket = ticket
        throw failure
      }
      try {
        await writeProjectContinuation(config, record.projectId)
        await synchronizeProjectState()
      } catch { /* A saved session remains usable even if the recents index cannot be updated. */ }
      return result
    })
  }

  async function commitConversation({ ticket, excerpts, contextKey, duplicate }) {
    if (!isSessionId(ticket)) throw new RequestError('会话预览已过期，请重新打开。', 409)
    const copy = duplicate === true
    const requestKey = keyFor(excerpts, contextKey, copy)
    const reuse = lastImport => ({ sessionId: lastImport.sessionId, reused: true, lastImport })
    const active = conversationTickets.get(ticket)
    if (active) {
      if (active.requestKey !== requestKey) throw new RequestError('正在迁入另一份续聊预览，请等待当前操作结束。', 409)
      return active.pending
    }
    const pending = (async () => {
      const config = await loadConfig()
      const record = await readConversationSnapshot(config, ticket)
      if (!record?.targetCwd || !record.messages.length) throw new RequestError('会话预览已过期或不能迁入，请重新打开。', 409)
      if (record.state !== 'preview' && (contextKey !== undefined || excerpts !== undefined)
        && contextKey !== record.continuation?.contextKey) {
        throw new RequestError('续聊内容已确定，请重新打开迁入预览。', 409)
      }
      if (record.state === 'done') return { sessionId: record.sessionId }
      const project = (snapshot ?? await scan()).projects.find(item => item.id === record.projectId)
      const source = sourceFor(project, record.sourceId)
      const sourceIds = [...new Set([...source.ids, ...(record.sourceIds ?? [])])]
      const getStatus = () => importStatus(config, record.projectId, { ...source, ids: sourceIds })
      const prior = record.state === 'preview' && !copy ? await getStatus() : undefined
      if (prior?.lastImport.sessionId) return reuse(prior.lastImport)
      if (record.state === 'preview') {
        const target = await conversationDirectory(record.targetCwd)
        if (!target || pathKey(target.path) !== pathKey(record.targetCwd) || target.identity !== record.targetIdentity) {
          throw new RequestError('目标目录已变化，请重新选择目录。', 409)
        }
        const continuation = excerpts !== undefined || contextKey !== undefined
          ? await reviewContinuation(record, config, excerpts) : null
        if (continuation && continuation.contextKey !== contextKey) {
          throw new RequestError('续聊内容已变化，请重新核对预览。', 409)
        }
        // Recheck receipts atomically with approval, including receipts completed after the host lookup.
        const unavailableImports = copy ? undefined : prior?.unavailableImports ?? []
        if (!await approveConversation(config, ticket, continuation, { unavailableImports, sourceIds })) {
          const completed = !copy && (await getStatus())?.lastImport
          if (completed?.sessionId) return reuse(completed)
          throw new RequestError('会话预览已过期或正在迁入，请重新打开。', 409)
        }
      }
      return writeApprovedConversation(config, ticket)
    })().finally(() => conversationTickets.delete(ticket))
    conversationTickets.set(ticket, { pending, requestKey })
    return pending
  }

  async function exportSession({ conversation, format, includeTrace, sessionId }) {
    if (!conversation || typeof conversation.title !== 'string' || conversation.title.length > 500
      || typeof conversation.path !== 'string' || conversation.path.length > 4096
      || !path.isAbsolute(conversation.path) || /[\u0000-\u001f]/u.test(conversation.path)
      || !Array.isArray(conversation.messages) || conversation.messages.length > 24) {
      throw new RequestError('DSH 会话资料格式无效。')
    }
    const sections = conversation.messages
      .filter(message => (message?.role === 'user' || message?.role === 'assistant')
        && typeof message.text === 'string' && message.text.trim())
      .map(message => ({ label: message.role === 'user' ? '用户' : 'DSH 助手', text: message.text,
        conversation: true, markdown: message.role === 'assistant' }))
    if (!sections.length) throw new RequestError('这段会话暂无可导出的消息。', 409)
    const title = redact(conversation.title.trim()) || 'DSH 会话'
    const { truncated, preview } = makePrompt({ name: title, cwd: conversation.path, agents: ['DSH'] }, sections, '')
    const saved = includeTrace === true ? await loadSourceRecord?.(sessionId) : undefined
    return makeExport({
      title, origin: 'DSH 会话', format,
      preview: { ...preview, truncated: truncated || conversation.truncated === true, trace: saved?.trace },
      includeTrace: includeTrace === true,
    })
  }

  return {
    dispose() {
      disposed = true
      wake()
      monitor.dispose()
      tickets.clear()
      openReferences.clear()
      conversationTickets.clear()
    },
    async execute(action, input) {
      if (['project-relay', 'add-relay-item', 'update-relay-item', 'remove-relay-item', 'export-relay'].includes(action)) {
        return projectRelay(action, input)
      }
      if (action === 'catalog') {
        const { projects, sources, scannedAt } = await scan(input.refresh === true)
        return { projects: projects.map(publicProject), sources, scannedAt, revision }
      }
      if (action === 'set-project-archive') return setProjectArchive(input)
      if (action === 'set-project-pin') return setProjectPin(input)
      if (action === 'set-project-selection') return setProjectSelection(input)
      if (action === 'record-project-continuation') return recordProjectContinuation(input.ticket)
      if (action === 'conversation-history' || action === 'discard-conversation-preview') {
        const config = await loadConfig()
        const id = input.snapshotId ?? input.ticket
        if (action === 'discard-conversation-preview') {
          await discardConversation(config, id)
          return {}
        }
        const page = await readHistoryPage(config, id, input.cursor, input.turn)
        if (!page) throw new RequestError('来源历史已过期，请重新打开预览。', 404)
        return page
      }
      if (action === 'preview-skill-activation') {
        if (!skillHandoff) throw new RequestError('当前 DSH 未提供原生技能启用服务。', 409)
        if (!isCatalogId(input.projectId) || !Array.isArray(input.assetIds)
          || !input.assetIds.length || input.assetIds.length > 8 || !input.assetIds.every(isCatalogId)) {
          throw new RequestError('技能启用请求格式无效。')
        }
        const current = snapshot ?? await scan()
        const project = requireProject(current, input.projectId)
        const entry = await detail(project.id)
        const wanted = new Set(input.assetIds)
        const assets = entry.skills.filter(item => wanted.has(item.id))
        if (assets.length !== wanted.size) throw new RequestError('所选技能已变化，请刷新项目。', 409)
        return await skillHandoff.preview(project, assets)
      }
      if (action === 'apply-skill-activation') {
        if (!skillHandoff) throw new RequestError('当前 DSH 未提供原生技能启用服务。', 409)
        if (typeof input.ticket !== 'string' || input.ticket.length > 128) {
          throw new RequestError('技能预览凭证无效。')
        }
        const result = await skillHandoff.apply(input.ticket)
        details.clear()
        revision++
        wake()
        return { ...result, revision }
      }
      if (action === 'deactivate-skill-activation' || action === 'undo-skill-activation') {
        if (!skillHandoff) throw new RequestError('当前 DSH 未提供原生技能启用服务。', 409)
        if (!isCatalogId(input.projectId) || !isCatalogId(input.activationId)) {
          throw new RequestError('技能启用记录格式无效。')
        }
        const current = snapshot ?? await scan()
        const project = requireProject(current, input.projectId)
        const result = action === 'undo-skill-activation'
          ? await skillHandoff.undo(project, input.activationId)
          : await skillHandoff.deactivate(project, input.activationId)
        details.clear()
        revision++
        wake()
        return { ...result, revision }
      }
      if (['list-conversations', 'search-conversations', 'conversation-import-status',
        'preview-conversation', 'preview-conversation-context', 'retarget-failed-conversation', 'import-conversation'].includes(action)) {
        if (!importConversation) throw new RequestError('当前 DSH 未提供会话迁入服务。', 409)
        if (action === 'list-conversations') return listConversations(input.projectId, input.recent === true, input.cursor)
        if (action === 'search-conversations') {
          const current = await scan()
          const project = requireProject(current, input.projectId)
          const result = await searchConversations(project, current.config, input)
          return { ...result, matches: await withImportStates(current.config, project, result.matches) }
        }
        if (action === 'conversation-import-status') {
          if (!isCatalogId(input.sessionId)) throw new RequestError('会话标识无效。')
          const current = await scan()
          const project = requireProject(current, input.projectId)
          return { lastImport: (await importStatus(current.config, project.id, sourceFor(project, input.sessionId)))?.lastImport ?? null }
        }
        if (action === 'preview-conversation') return previewConversation(input)
        if (action === 'retarget-failed-conversation') return previewConversation({
          projectId: input.projectId, sessionId: input.sessionId, snapshotId: input.ticket, targetCwd: input.targetCwd,
        }, true)
        if (action === 'preview-conversation-context') return previewContinuation(input)
        return commitConversation(input)
      }
      if (action === 'changes') {
        const inspect = async () => {
          const current = await scan()
          if (current.projects.some(item => item.id === input.projectId)) await detail(input.projectId)
        }
        await inspect()
        if (input.wait === true && input.revision === revision) {
          await waitForChange(input.revision)
          if (!disposed) await inspect()
        }
        return { revision, changed: input.revision !== revision, scannedAt: snapshot.scannedAt }
      }
      if (action === 'detail') {
        const {
          project, history, memories, skills, config, skillNativeAvailable, skillProjectRoot, managedSkills,
        } = await detail(input.projectId)
        let selection
        try { selection = await readProjectSelection(config, project.id) }
        catch (error) { throw storageFailure('读取', error, '项目资料选择') }
        return {
          project: publicProject(project), memories: memories.map(publicAsset), skills: skills.map(publicAsset),
          usedSkills: history.usedSkills, historyCount: history.messages.length, selection,
          skillNativeAvailable, skillProjectRoot, managedSkills,
        }
      }
      if (action === 'asset') {
        const entry = await detail(input.projectId)
        const item = [...entry.memories, ...entry.skills].find(asset => asset.id === input.assetId)
        if (!item) throw new RequestError('找不到所选资料。', 404)
        const result = await readAsset(item).catch(() => { throw new RequestError('资料已移动或不可读。', 409) })
        const text = redact(result.text)
        const references = isMarkdownFile(item.file) ? await markdownReferences(entry, item, text) : []
        return { ...result, text, references }
      }
      if (action === 'preview') return prepare(input)
      if (action === 'resolve-open-path') return resolveOpenPath(input)
      if (action === 'export') {
        const ticket = getTicket(input.ticket)
        return makeExport({
          title: redact(ticket.title), origin: '项目交接', format: input.format,
          preview: await exportPreview(ticket), date: new Date(ticket.created),
          includeTrace: input.includeTrace === true,
        })
      }
      if (action === 'export-session') return exportSession(input)
      if (action === 'open') {
        const ticket = getTicket(input.ticket)
        if (!ticket.path) throw new RequestError('原工作目录不可访问。可导出交接。', 409)
        const current = await currentDirectory(ticket.path)
        if (!current || pathKey(current) !== pathKey(ticket.path)) throw new RequestError('原工作目录已变化。', 409)
        ticket.opened = true
        return { path: current, prompt: ticket.prompt }
      }
      throw new RequestError('找不到该操作。', 404)
    },
  }
}
