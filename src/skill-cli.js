import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { authorizeProjectReference, listProjectAssets, readAsset, verifyAssetSource, verifySourceAuthorization } from './assets.js'
import { loadConfig } from './config.js'
import { canReadConversation, conversationId, conversationTitle, makePrompt, mergeProjects, pathKey, redact } from './handoff.js'
import { dateMillis, readConversationHistory, scanProjects } from './projects.js'

const usage = `Agent Bridge · DSH

projects [--agent <来源>] [--query <关键词>] [--page <页码>] [--include-archived]
inspect [--project <目录>] [--agent <来源>] [--query <关键词>] [--page <页码>]
        [--no-history] [--include-skills] [--include-global]
asset --asset <ID> [--include-skills] [--include-global]
history --session <ID> [--turn <回合>] [--cursor <位置>]
        [--output <Markdown文件> [--format local|share] [--include-trace]]
attachment --session <ID> --attachment <ID> --output <文件>
skill-info --asset <Skill ID>
project-state --operation pin|unpin|archive|restore
handoff [--session <ID> | --no-history] [--asset <ID> ...]
        [--include-skills] [--include-global] [--format prompt|local|share] [--output <文件>]

项目操作默认使用当前目录。可以用 --project 指定项目和 --agent 限定来源。
`

const string = { type: 'string' }
const boolean = { type: 'boolean' }
const assets = { type: 'string', multiple: true, default: [] }
const inventoryOptions = { 'include-skills': boolean, 'include-global': boolean }
const commandOptions = {
  projects: { query: string, page: string, 'include-archived': boolean },
  inspect: { query: string, page: string, 'no-history': boolean, ...inventoryOptions },
  asset: { asset: assets, page: string, ...inventoryOptions },
  history: { session: string, turn: string, cursor: string, format: string, 'include-trace': boolean, output: string },
  attachment: { session: string, attachment: string, output: string },
  'skill-info': { asset: assets, page: string },
  'project-state': { operation: string },
  handoff: { session: string, asset: assets, 'no-history': boolean, format: string, output: string, ...inventoryOptions },
}

const json = value => JSON.stringify(value) + '\n'
const isId = value => /^[a-f0-9]{24}$/.test(value ?? '')
const fold = value => String(value ?? '').trim().normalize('NFKC').toLowerCase()

function positiveInteger(value, name) {
  if (value === undefined) return
  if (!/^[1-9]\d{0,7}$/.test(value)) throw new Error(`${name} 必须是正整数。`)
  return Number(value)
}

function pageOf(items, page, size) {
  const end = page * size
  return { items: items.slice(end - size, end), more: items.length > end }
}

async function listProjects(config, matches, page, includeArchived) {
  const { readProjectState } = await import('./project-archive.js')
  const [{ projects, sources }, state] = await Promise.all([scanProjects(config), readProjectState(config)])
  const choices = mergeProjects(projects).filter(project =>
    (includeArchived || !state.archivedIds.has(project.id)) && matches(project.name, project.cwd, ...project.agents))
    .sort((a, b) => Number(Boolean(state.preferences.get(b.id)?.pinned)) - Number(Boolean(state.preferences.get(a.id)?.pinned))
      || String(b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name, 'zh-CN'))
  const selected = pageOf(choices, page, 20)
  return json({
    projects: await Promise.all(selected.items.map(async project => ({
      id: project.id, cwd: project.cwd, name: redact(project.name), agents: project.agents, updatedAt: project.updatedAt,
      online: (await stat(project.cwd).catch(() => undefined))?.isDirectory() ?? false,
      archived: state.archivedIds.has(project.id), pinned: state.preferences.get(project.id)?.pinned === true,
    }))),
    page, moreProjects: selected.more, sources,
  })
}

async function run(args) {
  if (args.length === 1 && args[0] === '--help') return usage
  const [action, ...flags] = args
  if (!Object.hasOwn(commandOptions, action)) throw new Error('操作无效。使用 --help 查看用法。')
  const { values } = parseArgs({
    args: flags,
    options: { agent: string, ...(action === 'projects' ? {} : { project: string }), ...commandOptions[action] },
  })
  const { project: requested, agent, query, session, asset: assetIds = [], output, cursor, attachment, operation } = values
  const noHistory = values['no-history'] === true || ['asset', 'skill-info', 'project-state'].includes(action)
  const includeSkills = values['include-skills'] === true || action === 'skill-info'
  const includeGlobalMemory = values['include-global'] === true
  const includeTrace = values['include-trace'] === true
  const format = values.format ?? (output ? 'local' : 'prompt')
  const page = positiveInteger(values.page, '页码') ?? 1
  const turn = positiveInteger(values.turn, '回合号')
  const filter = fold(query)
  const matches = (...fields) => !filter || fields.some(value => fold(value).includes(filter))
  if ((session !== undefined && (!isId(session) || noHistory))
    || assetIds.length > 24 || assetIds.some(id => !isId(id))
    || !['prompt', 'local', 'share'].includes(format)) {
    throw new Error('会话、资料或输出格式无效。使用 inspect 获取可用 ID。')
  }
  if (['history', 'attachment'].includes(action) && !session) throw new Error('请用 --session 指定要查看的会话。')
  if (action === 'attachment' && (!/^[a-f0-9]{64}$/.test(attachment ?? '') || !output?.trim())) {
    throw new Error('请指定在 history 中看到的附件 ID 和输出文件。')
  }
  if (action === 'history' && (output && cursor || output && format === 'prompt' || !output && (values.format || includeTrace))) {
    throw new Error('导出历史时请使用 --output 和可选的 local 或 share 格式，分页位置用于查看历史。')
  }
  if (['asset', 'skill-info'].includes(action) && assetIds.length !== 1) throw new Error('请指定一个资料 ID。')
  if (action === 'project-state' && !['pin', 'unpin', 'archive', 'restore'].includes(operation)) {
    throw new Error('请指定 pin、unpin、archive 或 restore。')
  }
  const config = await loadConfig()
  if (agent !== undefined) {
    const selected = new Set(['agentsview', ...Object.keys(config.agentRoots)])
    if (!selected.has(agent)) throw new Error(`不支持该来源。可用来源：${[...selected].join('、')}。`)
    for (const name of Object.keys(config.agentRoots)) {
      if (name !== agent) config.agentRoots[name] = []
    }
    if (agent !== 'agentsview') config.archiveFiles = []
  }
  if (action === 'projects') return listProjects(config, matches, page, values['include-archived'])
  if (requested !== undefined && !requested.trim()) throw new Error('项目目录不能为空。')
  const directory = path.resolve(requested ?? '.')
  const canonical = await realpath(directory).catch(error => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
  })
  const cwd = canonical ?? directory
  if (cwd === path.parse(cwd).root || (canonical && !(await stat(canonical)).isDirectory())) {
    throw new Error('请指定项目目录。')
  }
  config.projectRoots = canonical ? [cwd] : []
  const projectKey = pathKey(cwd)
  const { projects, sources } = await scanProjects(config, { includeTranscripts: !noHistory || !canonical })
  const [project] = mergeProjects(projects.filter(item => pathKey(item.cwd) === projectKey))
  if (!project) throw new Error('该目录不可访问，也没有匹配的本机归档。请用 projects 查找已知项目。')
  if (action === 'project-state') {
    const { writeProjectArchive, writeProjectPin } = await import('./project-archive.js')
    if (operation === 'pin' || operation === 'unpin') await writeProjectPin(config, project.id, operation === 'pin')
    else await writeProjectArchive(config, [project.id], operation === 'archive')
    return json({ project: project.name, cwd, operation })
  }
  const conversations = new Map()
  for (const archive of project.archives.filter(canReadConversation).sort((a, b) => dateMillis(b.date) - dateMillis(a.date))) {
    const id = conversationId(archive)
    if (!conversations.has(id)) conversations.set(id, archive)
  }
  if (session && !conversations.has(session)) throw new Error('所选会话不在这个项目或来源中。')
  if (action === 'history' || action === 'attachment') {
    const { readSkillHistory } = await import('./skill-history.js')
    return json(await readSkillHistory({
      project, archive: conversations.get(session), config, turn, cursor, format, includeTrace, output, attachment,
    }))
  }

  const inventory = new Map()
  if (action === 'inspect' || assetIds.length) {
    const found = await listProjectAssets(project, config, { projectMemoryOnly: true, includeSkills, includeGlobalMemory })
    for (const [kind, items] of [['memory', found.memories], ['skill', found.skills]]) {
      for (const item of items) {
        const id = createHash('sha256').update(item.file).digest('hex').slice(0, 24)
        if (!inventory.has(id)) inventory.set(id, { ...item, kind })
      }
    }
  }
  if (action === 'inspect') {
    const sessions = pageOf([...conversations].map(([id, archive]) => ({
      id, agent: archive.agent ?? archive.kind, title: conversationTitle(archive.title) || '未命名会话',
      date: dateMillis(archive.date) || undefined,
    })).filter(item => matches(item.title, item.agent)), page, 20)
    const material = kind => pageOf([...inventory].filter(([, item]) => item.kind === kind &&
      matches(redact(item.name), item.agent, redact(item.detail), redact(path.basename(item.file))))
      .map(([id, item]) => ({ id, name: redact(item.name), agent: item.agent, detail: redact(item.detail), scope: item.scope })),
    page, kind === 'skill' ? 20 : 40)
    const notes = material('memory')
    const skills = material('skill')
    return json({
      project: { cwd, name: redact(project.name), online: Boolean(canonical) },
      page, conversations: noHistory ? [] : sessions.items, moreConversations: !noHistory && sessions.more,
      memories: notes.items, moreMemories: notes.more, skills: skills.items, moreSkills: skills.more,
      sources: agent === undefined ? sources : sources.filter(source => source.id === agent),
    })
  }
  if (action === 'asset' || action === 'skill-info') {
    const item = inventory.get(assetIds[0])
    if (!item) throw new Error('所选资料不在这个项目中。请用相同的来源和筛选范围重新查看。')
    if (action === 'asset') {
      const { text, truncated } = await readAsset(item)
      const excerpt = pageOf(Array.from(redact(text)), page, 8_000)
      return json({
        name: redact(item.name), agent: item.agent, scope: item.scope, source: item.file,
        text: excerpt.items.join(''), page, more: excerpt.more, truncated,
      })
    }
    if (item.kind !== 'skill') throw new Error('请选择 Skill 资料。')
    const { readSkillPackage } = await import('./skill-package.js')
    const manifest = await readSkillPackage(item.file, { authorization: await verifyAssetSource(item) })
    const files = pageOf(manifest.files, page, 40)
    return json({
      name: manifest.name, description: redact(manifest.description), scope: item.scope, agent: item.agent,
      source: item.file, files: files.items.map(file => redact(file.rel)), page, more: files.more,
      fileCount: manifest.fileCount, bytes: manifest.bytes, hasScripts: manifest.hasScripts, invocation: manifest.invocation,
    })
  }

  const sections = await Promise.all([...new Set(assetIds)].map(async id => {
    const item = inventory.get(id)
    if (!item) throw new Error('所选资料不在这个项目中。')
    return {
      label: `${item.kind === 'skill' ? '来源 Skill 说明' : '项目资料'} · ${item.name}（${item.agent}）`,
      file: item.file, ...await readAsset(item),
    }
  }))
  if (!noHistory) {
    const selected = session ? [conversations.get(session)] : conversations.values()
    for (const archive of selected) {
      const history = await readConversationHistory(archive, cwd, config, { includeTrace: false }).catch(error => {
        if (session) throw error
        return undefined
      })
      if (!history?.messages.length) continue
      const recent = history.messages.slice(-8)
      if (recent[0].role === 'assistant' && !recent.some(item => item.role === 'user')) {
        const user = history.messages.findLast(item => item.role === 'user')
        if (user) recent.splice(0, 1, user)
      }
      sections.push({
        label: '会话来源',
        text: [archive.agent ?? archive.kind, conversationTitle(archive.title)].filter(Boolean).join(' · '),
        truncated: history.truncated || history.sourceStats.partial || history.messages.length > recent.length,
      })
      for (const message of recent) {
        const author = message.role === 'user' ? '用户' : '助手'
        sections.push({
          label: `近期会话 · ${author}`, text: message.text, conversation: true,
          markdown: message.role === 'assistant',
        })
      }
      break
    }
    if (!sections.some(item => item.conversation)) throw new Error('此项目或来源没有可读取的近期问答。仅交接项目资料时使用 --no-history。')
  }
  if (!sections.length) throw new Error('没有选择项目资料。请用 inspect 查看资料并传入 --asset。')

  const { prompt, preview } = makePrompt(project, sections, '')
  if (format === 'prompt' && !output) return prompt + '\n'
  if (format === 'prompt') {
    const { saveOutput } = await import('./skill-output.js')
    return json({ file: await saveOutput(output, [prompt + '\n']) })
  }
  const { makeExport } = await import('./export.js')
  if (canonical && assetIds.length) {
    const { relativeMarkdownLinks } = await import('../web/markdown.js')
    for (const section of preview.sections) {
      if (!section.file) continue
      section.references = await Promise.all(relativeMarkdownLinks(section.text).slice(0, 128).map(async href => {
        const reference = await authorizeProjectReference(cwd, section.file, href)
        const verified = reference.authorization && await verifySourceAuthorization(reference.authorization).catch(() => undefined)
        return { href, path: reference.path, verifiedFile: verified?.file }
      }))
    }
  }
  const markdown = makeExport({
    title: redact(project.name), origin: '项目交接', preview, format, savePath: output ? path.resolve(output) : undefined,
  }).markdown
  if (!output) return markdown
  const { saveOutput } = await import('./skill-output.js')
  return json({ file: await saveOutput(output, [markdown]) })
}

try {
  process.stdout.write(await run(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`Agent Bridge: ${redact(error.message)}\n`)
  process.exitCode = 1
}
