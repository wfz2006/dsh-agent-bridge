import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createCatalog } from '../src/catalog.js'
import { nativeSessionEvents, saveNativeSession } from '../src/session-import.js'

test('a reviewed conversation imports only that session, preserving repeated messages, with a retry-safe receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-native-history-'))
  const cwd = join(root, 'fixture')
  const otherCwd = join(root, 'other')
  const agent = join(root, '.codex')
  const file = join(agent, 'sessions', 'selected.jsonl')
  await Promise.all([mkdir(cwd), mkdir(otherCwd), mkdir(dirname(file), { recursive: true })])
  const row = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'text', text }] } })
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
  ])
  await write(join(dirname(file), 'same-project.jsonl'), cwd, [row('user', 'unselected chat')])
  await write(join(dirname(file), 'other-project.jsonl'), otherCwd, [row('user', 'another project')])
  const bytes = await readFile(file)
  let imports = 0
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
    imports++
    return { sessionId: record.sessionId }
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
  assert.equal(reviewed.truncated, false)
  assert.equal(reviewed.messages.length, 4)
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
