import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createCatalog } from '../src/catalog.js'
import { approveConversation, stageConversation } from '../src/conversation-store.js'
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


test('conversation lists exclude indexed placeholders and fill recent slots with readable prompts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-empty-history-'))
  let catalog
  t.after(async () => {
    await catalog?.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const cwd = join(root, 'project')
  const codex = join(root, 'codex')
  const copilot = join(root, 'editor')
  const editorWorkspace = join(copilot, 'workspaceStorage', 'project')
  await Promise.all([
    mkdir(cwd), mkdir(join(codex, 'sessions'), { recursive: true }),
    mkdir(join(editorWorkspace, 'chatSessions'), { recursive: true }),
  ])
  const write = (file, rows) => writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const message = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'text', text }] } })
  const entries = [
    ['metadata', 'Metadata only', [{ type: 'event_msg', payload: { type: 'task_started' } }]],
    ['runtime', 'Runtime instructions', [message('developer', 'internal setup'), message('user', '<environment_context>runtime</environment_context>')]],
    ['tool', 'Tool activity only', [{ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } }]],
    ['assistant', 'Assistant without a question', [message('assistant', 'Hello')]],
    ['waiting', 'Unanswered question', [message('user', 'Still waiting for an answer')]],
    ['late', 'Question after setup', [message('developer', 'x'.repeat(110 * 1024)), message('user', 'Actual question after the scan header')]],
    ['finished', 'Completed dialogue', [message('user', 'Question'), message('assistant', 'Answer')]],
  ]
  const index = new DatabaseSync(join(codex, 'state_5.sqlite'))
  try {
    index.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, title TEXT, has_user_event INTEGER)')
    const insert = index.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0)')
    for (const [offset, [id, title, messages]] of entries.entries()) {
      const file = join(codex, 'sessions', `${id}.jsonl`)
      await write(file, [{ type: 'session_meta', payload: { cwd, id } }, ...messages])
      insert.run(id, cwd, file, 1_794_000_000 - offset, title)
    }
  } finally {
    index.close()
  }
  await writeFile(join(editorWorkspace, 'workspace.json'), JSON.stringify({ folder: cwd }))
  const editorEmpty = join(editorWorkspace, 'chatSessions', 'empty.jsonl')
  await write(editorEmpty, [{ kind: 0, v: { requests: [] } }])
  catalog = createCatalog(() => ({
    home: root, configFile: join(root, 'agent-bridge.json'), workspaceHubRoots: [], archiveFiles: [],
    agentRoots: { codex: [codex], copilot: [copilot] },
  }), { importConversation: async () => assert.fail('listing must never import a session') })
  const { projects: [project] } = await catalog.execute('catalog', {})
  const input = { projectId: project.id }
  const recent = await catalog.execute('list-conversations', { ...input, recent: true })
  const history = await catalog.execute('list-conversations', input)
  assert.deepEqual(history.sessions.map(({ title }) => title), ['Unanswered question', 'Question after setup', 'Completed dialogue'])
  assert.deepEqual(recent, { sessions: history.sessions, total: 3 })
  for (const session of history.sessions) {
    const preview = await catalog.execute('preview-conversation', { ...input, sessionId: session.id })
    assert.equal(preview.messages[0].role, 'user')
  }

  // Opening a new editor chat writes its header before the first prompt.
  await write(editorEmpty, [{ kind: 0, v: { requests: [{ message: { text: 'New editor question' } }] } }])
  await catalog.execute('catalog', { refresh: true })
  const updated = await catalog.execute('list-conversations', { ...input, recent: true })
  assert.equal(updated.total, 4)
  assert.equal(updated.sessions[0].agent, 'copilot')
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

test('reviewed archives seed native thinking and tools between the corresponding replies without admitting them to model history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-native-process-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { home: root, configFile: join(root, 'agent-bridge.json') }
  const metadata = {
    id: '11e14a96-001a-4f90-b877-c11639ed05f1',
    sessionId: 'b77fa1ee-0dfc-4ad2-9e78-f55ac76c6852',
    title: 'Native timeline',
  }
  const message = (turn, role, text) => ({ kind: 'message', turn, role, text })
  const call = (callId, name) => ({ kind: 'tool_call', turn: 1, callId, name, text: '{}' })
  const result = (callId, text, status = 'ok') => ({ kind: 'tool_result', callId, text, status })
  const markdown = ['# C#', '', '```csharp', 'int a = 1;', '', '', 'int b = 2;', '```'].join('\n')
  const record = await stageConversation(config, metadata, [
    message(1, 'user', 'A'),
    message(1, 'assistant', 'Checking A'),
    { kind: 'summary', turn: 1, text: 'Visible thinking' },
    result('early', 'Result logged before its call'),
    call('first', 'read-alpha'),
    call('early', 'read-beta'),
    result('first', 'Result from alpha'),
    call('late', 'read-gamma'),
    call('missing', 'read-delta'),
    message(1, 'assistant', markdown),
    { kind: 'turn_end', turn: 1, status: 'interrupted' },
    message(2, 'user', 'B'),
    result('late', 'Result logged during B', 'error'),
    { kind: 'summary', turn: 2, text: 'Thinking for B' },
    message(2, 'assistant', 'Answer B'),
  ], value => value)
  assert.equal(await approveConversation(config, record.id), 1)
  const state = { writes: 0, attachments: 0 }
  await saveNativeSession(importServices(state), { ...record, config }, process.cwd())
  const rendered = state.events.flatMap(event => {
    if (event.type === 'user/message' && event.surfaceOp === 'append') return event.data.content.map(block => block.text)
    if (event.type === 'assistant/message') return event.data.message.content
      .filter(block => block.type === 'text' || block.type === 'reasoning').map(block => block.text)
    if (event.type === 'tool/call') return [event.data.name]
    return []
  })
  assert.deepEqual(rendered, ['A', 'Checking A', 'Visible thinking', 'read-alpha', 'read-beta', 'read-gamma',
    'read-delta', markdown, 'B', 'Thinking for B', 'Answer B'])
  const dispatched = new Map(state.events.filter(event => event.type === 'tool/call').map(event => [event.data.callId, event]))
  const results = state.events.filter(event => event.type === 'tool/result')
  assert.deepEqual(results.map(event => event.data.message.content[0].text), [
    'Result logged before its call', 'Result from alpha', 'Result logged during B',
  ])
  for (const event of results) {
    const start = dispatched.get(event.data.message.toolCallId)
    assert.equal(start.data.turn, 1)
    assert.equal(event.data.turn, start.data.turn)
    assert.equal(event.data.step, start.data.step)
    assert.deepEqual(event.sourceEventSeqs, [start.seq])
    assert.ok(event.seq > start.seq)
  }
  assert.equal(results.at(-1).data.message.isError, true)
  assert.deepEqual(state.events.find(event => event.type === 'turn/end').data.reason, {
    kind: 'aborted', reason: { kind: 'legacy' },
  })
  const modelSurface = []
  for (const event of state.events) {
    if (event.surfaceOp === 'append') modelSurface.push(event)
    else if (event.surfaceOp?.op === 'replace') {
      const start = modelSurface.findIndex(item => item.seq === event.surfaceOp.startSeq)
      const end = modelSurface.findIndex(item => item.seq === event.surfaceOp.endSeq)
      assert.ok(start >= 0 && end >= start)
      modelSurface.splice(start, end - start + 1, event)
    }
  }
  assert.deepEqual(modelSurface.flatMap(event => (event.data.message ?? event.data).content),
    ['A', 'Checking A', markdown, 'B', 'Answer B'].map(text => ({ type: 'text', text })))
})

test('native user attachments are rendered from reviewed bytes and the resumed model receives only the question', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-native-attachments-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { home: root, configFile: join(root, 'agent-bridge.json') }
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const file = Buffer.from('项目文件\n')
  const record = await stageConversation(config, {
    id: 'b9dd0ae3-6da8-49b3-bb1e-57cf1a9af6c4', sessionId: '759127b3-094c-4fec-877a-798f51bcc4f5', title: 'Attachments',
  }, [
    { kind: 'message', turn: 1, role: 'user', text: 'Review the attachments.' },
    { kind: 'attachment', turn: 1, role: 'user', name: '图 #1 (50%).png', data: png },
    { kind: 'attachment', turn: 1, role: 'user', name: '文档 #2 %.txt', data: file },
    { kind: 'attachment', turn: 1, role: 'user', name: '旧草稿.txt', status: 'name-only' },
    { kind: 'message', turn: 1, role: 'assistant', text: 'Reviewed.' },
  ], value => value)
  assert.equal(await approveConversation(config, record.id), 1)
  const state = { writes: 0, attachments: 0 }
  const services = { ...importServices(state), attachments: {
    async saveImage({ data, mediaType, name }) {
      assert.deepEqual(data, png)
      return { attachmentId: 'image-id', mediaType, bytes: data.length, name, width: 1, height: 1 }
    },
    async saveFile({ data, name }) {
      assert.deepEqual(data, file)
      return { attachmentId: 'file-id', bytes: data.length, name }
    },
  } }
  await saveNativeSession(services, { ...record, config }, process.cwd())
  const user = state.events.filter(event => event.type === 'user/message')
  assert.deepEqual(user[0].data.content.filter(block => block.attachment)
    .map(block => [block.type, block.attachment.name]), [['image', '图 #1 (50%).png'], ['file', '文档 #2 %.txt']])
  assert.ok(user[0].data.content.some(block => block.text?.includes('旧草稿.txt')))
  assert.equal(user[1].surfaceOp.startSeq, user[0].seq)
  assert.equal(user[1].surfaceOp.endSeq, user[0].seq)
  assert.deepEqual(user[1].data.content, [{ type: 'text', text: 'Review the attachments.' }])
})

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
