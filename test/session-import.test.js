import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createCatalog } from '../src/catalog.js'
import { nativeSessionEvents, saveNativeSession } from '../src/session-import.js'
import { readSessionTrace } from '../src/session-trace.js'

test('a reviewed conversation imports only that session, preserving repeated messages, with a retry-safe receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-native-history-'))
  const cwd = join(root, 'fixture')
  const otherCwd = join(root, 'other')
  const agent = join(root, '.codex')
  const file = join(agent, 'sessions', 'selected.jsonl')
  await Promise.all([mkdir(cwd), mkdir(otherCwd), mkdir(dirname(file), { recursive: true })])
  const row = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'text', text }] } })
  const skillCall = name => ({
    type: 'response_item',
    payload: { type: 'function_call', name: 'skill', arguments: JSON.stringify({ name }) },
  })
  const write = (file, cwd, messages) => writeFile(file, [
    { type: 'session_meta', payload: { cwd } },
    ...messages,
  ].map(value => JSON.stringify(value)).join('\n'))
  await write(file, cwd, [
    row('developer', 'foreign system instructions'),
    row('user', '<environment_context>runtime metadata</environment_context>'),
    row('user', 'Remember the blue key.'),
    row('assistant', 'Got it.'),
    row('user', 'api_key = hide-me-now'),
    row('assistant', 'Got it.'),
    skillCall('audit-probe'),
  ])
  await write(join(dirname(file), 'same-project.jsonl'), cwd, [row('user', 'unselected chat')])
  await write(join(dirname(file), 'other-project.jsonl'), otherCwd, [row('user', 'another project')])
  const bytes = await readFile(file)
  let imports = 0
  const candidateCalls = []
  const catalog = createCatalog(() => ({
    home: root, configFile: join(root, 'agent-bridge.json'),
    agentRoots: { codex: [agent] }, workspaceHubRoots: [], archiveFiles: [],
  }), { importConversation: async (record, path) => {
    assert.equal(path, cwd)
    assert.deepEqual(record.messages.map(({ role, text }) => [role, text]), [
      ['user', 'Remember the blue key.'], ['assistant', 'Got it.'],
      ['user', 'api_key = [已隐藏]'], ['assistant', 'Got it.'],
    ])
    assert.equal(record.title, 'Remember the blue key.')
    assert.deepEqual(record.sourceStats, { userMessages: 2, assistantMessages: 2, importedMessages: 4, partial: false })
    imports++
    return { sessionId: record.sessionId }
  }, skillHandoff: {
    async inspect(_project, skills) {
      return { available: true, projectRoot: cwd, skills: Object.fromEntries(skills.map(skill => [skill.id, {}])) }
    },
    async conversationCandidates(_project, usedSkills) {
      candidateCalls.push([...usedSkills])
      return usedSkills.includes('audit-probe')
        ? [{ assetId: 'a'.repeat(24), name: 'audit-probe', label: '可为此项目启用', allowed: true, action: 'enable' }]
        : []
    },
  } })
  t.after(async () => { catalog.dispose(); await rm(root, { recursive: true, force: true }) })
  const { projects } = await catalog.execute('catalog', {})
  const project = projects.find(item => item.cwd === cwd)
  const other = projects.find(item => item.cwd === otherCwd)
  const { sessions } = await catalog.execute('list-conversations', { projectId: project.id })
  assert.equal(sessions.length, 2)
  assert.deepEqual(sessions.map(session => session.title).sort(), ['Remember the blue key.', 'unselected chat'])
  const { sessions: [foreign] } = await catalog.execute('list-conversations', { projectId: other.id })
  await assert.rejects(catalog.execute('preview-conversation', { projectId: project.id, sessionId: foreign.id }), { status: 404 })
  await assert.rejects(catalog.execute('import-conversation', { ticket: 'arbitrary' }), { status: 409 })
  const previews = await Promise.all(sessions.map(({ id }) => catalog.execute('preview-conversation', { projectId: project.id, sessionId: id })))
  const reviewed = previews.find(item => item.title === 'Remember the blue key.')
  const unselected = previews.find(item => item.title === 'unselected chat')
  assert.equal(reviewed.truncated, false)
  assert.equal(reviewed.messages.length, 4)
  assert.deepEqual(reviewed.sourceStats, { userMessages: 2, assistantMessages: 2, importedMessages: 4, partial: false })
  assert.deepEqual(reviewed.skillCandidates.map(item => item.name), ['audit-probe'])
  assert.deepEqual(unselected.skillCandidates, [])
  assert.deepEqual(candidateCalls.sort(), [[], ['audit-probe']])
  assert.equal(imports, 0)
  const request = { ticket: reviewed.ticket, messages: [row('user', 'unreviewed input')] }
  const [first, second] = await Promise.all([catalog.execute('import-conversation', request), catalog.execute('import-conversation', request)])
  assert.deepEqual(first, second)
  assert.equal(imports, 1)
  assert.deepEqual(await readFile(file), bytes)
})

test('native history writes finished turns and retries workspace attachment without recreating the log', async () => {
  const messages = [
    { role: 'user', text: 'First', time: 100 },
    { role: 'assistant', text: 'Reply A', time: 101 },
    { role: 'assistant', text: 'Reply B', time: 102 },
    { role: 'user', text: 'Unanswered', time: 103 },
  ]
  const events = nativeSessionEvents(messages, 'Imported')
  assert.deepEqual(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind), ['completed', 'interrupted'])
  assert.deepEqual(events.filter(event => event.type === 'assistant/message').map(event => event.data.step), [1, 2])
  const record = { sessionId: 'new-id', title: 'Imported', messages }
  const state = { writes: 0, attachments: 0 }
  const workspace = { path: process.cwd(), sessionIds: [], async attachSession(id) {
    if (++state.attachments === 1) throw new Error('workspace temporarily unavailable')
    this.sessionIds.push(id)
  } }
  const services = {
    sessions: { prepare(id, { meta }) { return { header: { id, version: 4, ...meta } } } },
    persistence: { async create() {
      state.writes++
      return { async append() {}, async flush() {}, async close() {} }
    } },
    workspaces: { async create() { return workspace } },
  }
  await assert.rejects(saveNativeSession(services, record, process.cwd()), /workspace temporarily unavailable/)
  assert.deepEqual(await saveNativeSession(services, record, process.cwd()), { sessionId: 'new-id' })
  assert.equal(state.writes, 1)
})

function importServices(state) {
  const workspace = { path: process.cwd(), sessionIds: [], async attachSession(id) {
    state.attachments++
    this.sessionIds.push(id)
  } }
  return {
    sessions: { prepare(id, { meta }) { return { header: { id, version: 4, ...meta } } } },
    persistence: { async create() {
      state.writes++
      return { async append(events) { state.events = events }, async flush() {}, async close() {} }
    } },
    workspaces: { async create() { return workspace } },
  }
}

const trace = [
  { id: 't1', kind: 'summary', text: '先核对现场。', status: 'ok', messageIndex: 0 },
  { id: 't2', kind: 'tool_call', name: 'shell', callId: 'c1', text: 'pnpm test', status: 'ok', messageIndex: 1 },
  { id: 't3', kind: 'tool_result', name: 'shell', callId: 'c1', text: '90 passing', status: 'ok', messageIndex: 1 },
]

test('the reviewed source trace is saved beside the config before the session joins the workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-import-trace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { home: root, configFile: join(root, 'agent-bridge.json') }
  const state = { writes: 0, attachments: 0 }
  const record = {
    sessionId: '4a1c2b30-1111-4222-8333-944455556666', title: 'Imported',
    messages: [{ role: 'user', text: 'First' }, { role: 'assistant', text: 'Reply' }],
    config, trace,
  }
  const services = importServices(state)
  assert.deepEqual(await saveNativeSession(services, record, process.cwd()), { sessionId: record.sessionId })
  assert.equal(record.traceStored, true)
  const saved = JSON.parse(await readFile(join(root, 'agent-bridge-traces', `${record.sessionId}.json`), 'utf8'))
  assert.deepEqual(saved.trace.map(item => item.id), ['t1', 't2', 't3'])
  // The trace never becomes a replayable DSH event.
  const types = new Set(state.events.map(event => event.type))
  assert.deepEqual([...types].sort(), ['assistant/message', 'session/title', 'step/end', 'step/start', 'system/message', 'turn/end', 'turn/start', 'user/message'])
  assert.equal(state.events.some(event => /trace|tool/i.test(event.type)), false)
  // Retrying the same record does not write a second log, trace, or attachment.
  await saveNativeSession(services, record, process.cwd())
  assert.equal(state.writes, 1)
  assert.equal(state.attachments, 1)
})

test('a trace write failure reports partial success, keeps the stored log, and retries only the trace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-import-trace-fail-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const blocker = join(root, 'blocker')
  await writeFile(blocker, 'not a directory')
  const broken = { home: root, configFile: join(blocker, 'agent-bridge.json') }
  const good = { home: root, configFile: join(root, 'agent-bridge.json') }
  const state = { writes: 0, attachments: 0 }
  const record = {
    sessionId: '5b2d3c40-2222-4333-8444-a55566667777', title: 'Imported',
    messages: [{ role: 'user', text: 'First' }], config: broken, trace,
  }
  await assert.rejects(saveNativeSession(importServices(state), record, process.cwd()), {
    status: 503, message: /来源记录暂时无法保存/,
  })
  assert.ok(record.stored)
  assert.equal(record.traceStored, undefined)
  assert.equal(state.writes, 1)
  assert.equal(state.attachments, 0)
  const retry = { ...record, config: good }
  assert.deepEqual(await saveNativeSession(importServices(state), retry, process.cwd()), { sessionId: record.sessionId })
  assert.equal(state.writes, 1)
  assert.equal(state.attachments, 1)
  assert.equal(retry.traceStored, true)
  assert.ok(await readFile(join(root, 'agent-bridge-traces', `${record.sessionId}.json`), 'utf8'))
})

test('an import without a config or trace skips the trace store entirely', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-import-no-trace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = { writes: 0, attachments: 0 }
  const record = { sessionId: '6c3e4d50-3333-4444-8555-b66677778888', title: 'Imported', messages: [{ role: 'user', text: 'First' }] }
  await saveNativeSession(importServices(state), record, process.cwd())
  assert.equal(record.traceStored, undefined)
  assert.deepEqual(await readdir(join(root, 'agent-bridge-traces')).catch(() => []), [])
})

test('a text-only import keeps source statistics in the same durable record', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-import-stats-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { home: root, configFile: join(root, 'agent-bridge.json') }
  const state = { writes: 0, attachments: 0 }
  const sourceStats = { userMessages: 3, assistantMessages: 2, importedMessages: 2, partial: true, elapsedMs: 70_000 }
  const record = {
    sessionId: '7d4e5f60-4444-4555-8666-c77788889999', title: 'Imported text',
    messages: [{ role: 'user', text: 'Question' }, { role: 'assistant', text: 'Reply' }],
    config, trace: [], sourceStats,
  }
  const services = importServices(state)
  await saveNativeSession(services, record, process.cwd())
  await saveNativeSession(services, record, process.cwd())
  assert.equal(state.writes, 1)
  assert.equal(state.attachments, 1)
  const saved = await readSessionTrace(config, record.sessionId)
  assert.deepEqual(saved?.sourceStats, sourceStats)
  assert.deepEqual(saved.trace, [])
  assert.equal(state.events.some(event => /stats|tool/i.test(event.type)), false)
})
