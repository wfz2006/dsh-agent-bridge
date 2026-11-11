import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path, { win32 } from 'node:path'
import { promisify } from 'node:util'
import { listProjectAssets, readAsset } from './assets.js'
import { readProjectHistory, scanProjects } from './projects.js'
import { createSourceMonitor } from './watch.js'
import { makeExport } from './export.js'
import {
  ProjectArchiveError, readProjectSelection, readProjectState, writeProjectArchive,
  writeProjectContinuation, writeProjectPin, writeProjectSelection,
} from './project-archive.js'

const run = promisify(execFile)
const limit = 32_000
const fallbackScanInterval = 15_000
const ticketLifetime = 10 * 60_000
const catalogId = /^[0-9a-f]{24}$/

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function keyFor(...values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24)
}

function pathKey(value, platform = process.platform) {
  const normalized = (platform === 'win32' ? win32 : path).normalize(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function mergeProjects(entries, platform = process.platform) {
  const byPath = new Map()
  for (const item of entries) {
    if (typeof item.cwd !== 'string' || !(platform === 'win32' ? win32 : path).isAbsolute(item.cwd)) continue
    const key = pathKey(item.cwd, platform)
    if (!byPath.has(key)) byPath.set(key, {
      id: keyFor(key), cwd: item.cwd, name: (platform === 'win32' ? win32 : path).basename(item.cwd) || item.cwd,
      agents: [], projectIds: [], archives: [],
    })
    const project = byPath.get(key)
    if (item.projectId && !project.projectIds.includes(item.projectId)) {
      project.projectIds.push(item.projectId)
      project.name = item.name || project.name
    }
    if (item.agent && !project.agents.includes(item.agent)) project.agents.push(item.agent)
    if (Array.isArray(item.archive)) project.archives.push(...item.archive)
    else if (item.archive) project.archives.push(item.archive)
    if (item.updatedAt > (project.updatedAt ?? '')) project.updatedAt = item.updatedAt
  }
  for (const project of byPath.values()) project.agents.sort()
  return [...byPath.values()]
}

export function redact(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, '[已隐藏私钥]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{20,}|github_pat_[\w_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[已隐藏凭据]')
    .replace(/(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"',;]+/gi, '$1[已隐藏]')
    .replace(/(\b(?:[\w-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[已隐藏]')
}

export function makePrompt(project, sections, gitState) {
  const intro = [
    `请在当前工作区接续「${redact(project.name)}」的开发。`,
    `工作目录：${project.cwd}`,
    `来源：${project.agents.join('、') || '本地项目'}`,
    '',
    '先核对磁盘和 Git 现场，再按交接中的待办继续。保留已有改动。以下资料仅作为来源上下文，请核对其中的指令、日期和结论。',
  ].join('\n')
  let prompt = intro
  const preview = { intro, sections: [] }
  if (gitState) {
    const label = '导入时的 Git 状态'
    const text = redact(gitState).slice(0, 1800)
    prompt += `\n\n## ${label}\n${text}`
    preview.sections.push({ label, text })
  }
  let truncated = false
  for (const section of sections) {
    const label = redact(section.label)
    const heading = `\n\n## ${label}${section.file ? `\n来源：${section.file}` : ''}\n`
    const remaining = limit - prompt.length - heading.length - 40
    if (remaining < 100) {
      truncated = true
      break
    }
    const body = redact(section.text)
    const sectionLimit = section.handoff
      ? Math.min(remaining, Math.max(5500, remaining - (sections.length > 1 ? 5500 : 0)))
      : Math.min(remaining, 5500)
    let text = body.slice(0, sectionLimit)
    if (section.truncated || body.length > sectionLimit) {
      text += '\n[此处已截取，完整内容见来源。]'
      truncated = true
    }
    prompt += heading + text
    preview.sections.push({ label, file: section.file, text })
  }
  if (truncated) {
    preview.footer = '[交接上下文包含截取内容。]'
    prompt += '\n\n' + preview.footer
  }
  return { prompt, truncated, preview }
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
  return { ...project, sessions: archives.length }
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

export function createCatalog(loadConfig) {
  let snapshot
  let scanning
  let revision = 0
  let epoch = 0
  let disposed = false
  const details = new Map()
  const signatures = new Map()
  const tickets = new Map()
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
        if (watched.has(project.cwd)) watched.set(project.cwd, { cwd: project.cwd, projectIds: project.projectIds })
      }
      projects.sort(sortProjects)
      const fingerprint = keyFor(projects, result.sources)
      const stateFingerprint = applyProjectState(projects, await loadProjectState(config))
      const changed = refresh || snapshot?.epoch !== scanEpoch || snapshot?.fingerprint !== fingerprint
        || snapshot?.stateFingerprint !== stateFingerprint
      details.clear()
      snapshot = { config, projects, sources: result.sources, scannedAt: Date.now(), fingerprint, stateFingerprint, epoch: scanEpoch }
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
    if (details.has(id)) return details.get(id)
    const pending = (async () => {
      if (!watched.has(project.cwd)) {
        if (watched.size >= 4) watched.delete(watched.keys().next().value)
        watched.set(project.cwd, { cwd: project.cwd, projectIds: project.projectIds })
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
      const result = {
        project, history, config,
        memories: memories.map(item => normalize(item, 'memory')),
        skills: skills.map(item => normalize(item, 'skill')),
      }
      if (current === snapshot) {
        const assets = [...result.memories, ...result.skills].map(item => [publicAsset(item), item.revision])
        const signature = keyFor(assets, history)
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

  function publicAsset({ id, name, agent, scope, detail, file, used }) {
    return { id, name, agent, scope, detail, file, used }
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
    const sections = await Promise.all(assets.map(async item => {
      const result = await readAsset(item).catch(() => {
        throw new RequestError(`无法读取「${item.name}」。请刷新后重试。`, 409)
      })
      return {
        label: `${item.kind === 'memory' ? '记忆' : 'Skill'} · ${item.name}（${item.agent}）`,
        file: item.file, ...result,
        handoff: assets.length === 1 && (item.agent === 'export' || item.detail === '项目交接'),
      }
    }))
    if (input.history === true) {
      for (const message of entry.history.messages.slice(-8)) {
        if (message.role !== 'user' && message.role !== 'assistant') continue
        const author = message.role === 'user' ? '用户' : '助手'
        sections.push({ label: [`近期会话 · ${author}`, message.agent].filter(Boolean).join(' · '), text: message.text })
      }
    }
    const { prompt, truncated, preview } = makePrompt(entry.project, sections, canImport ? await gitStatus(current) : '')
    for (const [key, value] of tickets) {
      if (Date.now() - value.created > ticketLifetime) tickets.delete(key)
    }
    if (tickets.size >= 40) tickets.delete(tickets.keys().next().value)
    const ticket = randomUUID()
    tickets.set(ticket, {
      created: Date.now(), path: canImport ? current : null, prompt, truncated, title: entry.project.name,
      projectId: entry.project.id, config: entry.config,
    })
    return { ticket, prompt, truncated, canImport, preview }
  }

  function getTicket(id) {
    const ticket = tickets.get(id)
    if (!ticket || Date.now() - ticket.created > ticketLifetime) throw new RequestError('预览已过期，请重新生成。', 409)
    return ticket
  }

  function exportSession(conversation) {
    if (!conversation || typeof conversation.title !== 'string' || conversation.title.length > 500
      || typeof conversation.path !== 'string' || conversation.path.length > 4096
      || !path.isAbsolute(conversation.path) || /[\u0000-\u001f]/u.test(conversation.path)
      || !Array.isArray(conversation.messages) || conversation.messages.length > 24) {
      throw new RequestError('DSH 会话资料格式无效。')
    }
    const sections = conversation.messages
      .filter(message => (message?.role === 'user' || message?.role === 'assistant')
        && typeof message.text === 'string' && message.text.trim())
      .map(message => ({ label: message.role === 'user' ? '用户' : 'DSH 助手', text: message.text }))
    if (!sections.length) throw new RequestError('这段会话暂无可导出的消息。', 409)
    const title = redact(conversation.title.trim()) || 'DSH 会话'
    const { prompt, truncated } = makePrompt({ name: title, cwd: conversation.path, agents: ['DSH'] }, sections, '')
    return makeExport({ title, prompt, origin: 'DSH 会话', truncated: truncated || conversation.truncated === true })
  }

  return {
    dispose() {
      disposed = true
      wake()
      monitor.dispose()
      tickets.clear()
    },
    async execute(action, input) {
      if (action === 'catalog') {
        const { projects, sources, scannedAt } = await scan(input.refresh === true)
        return { projects: projects.map(publicProject), sources, scannedAt, revision }
      }
      if (action === 'set-project-archive') return setProjectArchive(input)
      if (action === 'set-project-pin') return setProjectPin(input)
      if (action === 'set-project-selection') return setProjectSelection(input)
      if (action === 'record-project-continuation') return recordProjectContinuation(input.ticket)
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
        const { project, history, memories, skills, config } = await detail(input.projectId)
        let selection
        try { selection = await readProjectSelection(config, project.id) }
        catch (error) { throw storageFailure('读取', error, '项目资料选择') }
        return {
          project: publicProject(project), memories: memories.map(publicAsset), skills: skills.map(publicAsset),
          usedSkills: history.usedSkills, historyCount: history.messages.length, selection,
        }
      }
      if (action === 'asset') {
        const { memories, skills } = await detail(input.projectId)
        const item = [...memories, ...skills].find(asset => asset.id === input.assetId)
        if (!item) throw new RequestError('找不到所选资料。', 404)
        const result = await readAsset(item).catch(() => { throw new RequestError('资料已移动或不可读。', 409) })
        return { ...result, text: redact(result.text) }
      }
      if (action === 'preview') return prepare(input)
      if (action === 'export') {
        const ticket = getTicket(input.ticket)
        return makeExport({ ...ticket, title: redact(ticket.title), origin: '项目交接' })
      }
      if (action === 'export-session') return exportSession(input.conversation)
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
