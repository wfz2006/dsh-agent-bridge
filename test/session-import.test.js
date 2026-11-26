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

test('project body search locates the original turn and carries reviewed excerpts across sessions into the DSH model surface', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-search-'))
  const cwd = join(root, 'fixture')
  const other = join(root, 'other')
  const agent = join(root, 'codex')
  const dir = join(agent, 'sessions')
  await Promise.all([mkdir(cwd), mkdir(other), mkdir(dir, { recursive: true })])
  const config = { home: root, configFile: join(root, 'agent-bridge.json'),
    agentRoots: { codex: [agent] }, workspaceHubRoots: [], archiveFiles: [] }
  const write = (id, folder, pairs) => writeFile(join(dir, id + '.jsonl'), [
    { type: 'session_meta', payload: { cwd: folder } },
    ...pairs.flatMap(([question, answer]) => [['user', question], ['assistant', answer]])
      .map(([role, text]) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'text', text }] } })),
  ].map(value => JSON.stringify(value)).join('\n'))
  const long = '旧'.repeat(80_000) + '保留格式 SQLITE_BUSY'
  await write('old', cwd, [['First title', long],
    ...Array.from({ length: 28 }, (_, i) => [`Later question ${i}`, `Failure [x]+. ${i}`])])
  await write('new', cwd, [['Continue', 'New reply']])
  await write('outside', other, [['Unrelated title', '保留格式 SQLITE_BUSY']])
  let imported
  let failures = 0
  const catalog = createCatalog(() => config, { importConversation: async record => {
    const { nativeTranscriptEvents } = await import('../src/native-transcript.js')
    imported = await nativeTranscriptEvents(record)
    if (!failures++) throw new Error('temporary host failure')
    return { sessionId: record.sessionId }
  } })
  t.after(async () => { catalog.dispose(); await rm(root, { recursive: true, force: true }) })
  const { projects } = await catalog.execute('catalog', {})
  const projectId = projects.find(p => p.cwd === cwd).id
  const otherId = projects.find(p => p.cwd === other).id
  const paged = await catalog.execute('search-conversations', { projectId, query: '[x]+.' })
  const tail = await catalog.execute('search-conversations', { projectId, query: '[x]+.', cursor: paged.nextCursor })
  assert.equal(paged.matches.length, 24)
  assert.deepEqual(tail.matches.map(match => match.turn), [26, 27, 28, 29])
  await assert.rejects(catalog.execute('search-conversations', { projectId: otherId, query: '[x]+.', cursor: paged.nextCursor }), { status: 409 })
  const { matches } = await catalog.execute('search-conversations', { projectId, query: '保留格式 sqlite_busy' })
  assert.equal(matches.length, 1)
  const hit = matches[0]
  assert.equal(hit.turn, 1)
  assert.equal(hit.title, 'First title')
  assert.match(hit.snippet, /保留格式 SQLITE_BUSY/)
  const old = await catalog.execute('preview-conversation', { projectId, sessionId: hit.id, searchHit: hit })
  const page = await catalog.execute('conversation-history', { snapshotId: old.history.snapshotId, ...old.historyLocation })
  const item = page.items.find(item => item.text?.includes('保留格式 SQLITE_BUSY'))
  assert.equal(item?.turn, 1)
  const excerpts = [{ snapshotId: old.history.snapshotId, seq: item.seq, offset: item.offset }]
  const { sessions } = await catalog.execute('list-conversations', { projectId })
  const latest = await catalog.execute('preview-conversation', { projectId, sessionId: sessions.find(s => s.title === 'Continue').id })
  const relayOne = await catalog.execute('add-relay-item', { projectId, ...excerpts[0], category: 'decided' })
  const latestPage = await catalog.execute('conversation-history', { snapshotId: latest.history.snapshotId })
  const question = latestPage.items.find(entry => entry.role === 'user')
  const relayTwo = await catalog.execute('add-relay-item', { projectId, snapshotId: latest.history.snapshotId,
    seq: question.seq, offset: question.offset, category: 'unresolved' })
  assert.notEqual(relayOne.source.id, relayTwo.source.id)
  const updated = await catalog.execute('update-relay-item', { projectId, id: relayTwo.id, category: 'next', text: 'Verify the next run' })
  assert.deepEqual(updated.source, relayTwo.source)
  const { markdown } = await catalog.execute('export-relay', { projectId })
  assert.match(markdown, /## 已决定[\s\S]*保留格式 SQLITE_BUSY[\s\S]*## 已完成[\s\S]*## 未解决[\s\S]*## 下一步[\s\S]*Verify the next run/)
  assert.deepEqual((await catalog.execute('project-relay', { projectId: otherId })).items, [])
  const foreign = await catalog.execute('search-conversations', { projectId: otherId, query: 'sqlite_busy' })
  const foreignPreview = await catalog.execute('preview-conversation', { projectId: otherId, sessionId: foreign.matches[0].id })
  await assert.rejects(catalog.execute('preview-conversation-context', { ticket: latest.ticket,
    excerpts: [{ ...excerpts[0], snapshotId: foreignPreview.history.snapshotId }] }), { status: 409 })
  const reviewed = await catalog.execute('preview-conversation-context', { ticket: latest.ticket, excerpts })
  assert.match(reviewed.firstMessage, /第一|第 1 轮/)
  assert.match(reviewed.firstMessage, /保留格式 SQLITE_BUSY/)
  assert.match(reviewed.firstMessage, /Continue/)
  await assert.rejects(catalog.execute('import-conversation', { ticket: latest.ticket, excerpts: [], contextKey: reviewed.contextKey }), { status: 409 })
  const commit = { ticket: latest.ticket, excerpts, contextKey: reviewed.contextKey }
  await assert.rejects(catalog.execute('import-conversation', commit), { status: 503 })
  await catalog.execute('discard-conversation-preview', { snapshotId: old.history.snapshotId })
  const jumped = await catalog.execute('preview-conversation', { projectId, sessionId: hit.id, relayId: relayOne.id })
  const original = await catalog.execute('conversation-history', { snapshotId: jumped.history.snapshotId, ...jumped.historyLocation })
  assert.equal(original.items.find(entry => entry.seq === jumped.historyLocation.seq).text, item.text)
  await catalog.execute('remove-relay-item', { projectId, id: relayTwo.id })
  assert.deepEqual((await catalog.execute('project-relay', { projectId })).items, [relayOne])
  const pending = await catalog.execute('preview-conversation', {
    projectId, sessionId: sessions.find(s => s.title === 'Continue').id, snapshotId: latest.history.snapshotId,
  })
  assert.equal(pending.messages[0].text, reviewed.firstMessage)
  await catalog.execute('import-conversation', commit)
  const { events } = imported
  const historyUser = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
  const contextUser = events.find(event => event.type === 'user/message' && event.data.source.kind === 'agent-bridge-context')
  assert.equal(historyUser.data.content[0].text, 'Continue')
  assert.equal(contextUser.data.content[0].text, reviewed.firstMessage)
  assert.equal(contextUser.surfaceOp.op, 'replace')
})

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

test('reopening a migrated source uses the latest available DSH session and only creates an explicit copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-import-reuse-'))
  const cwd = join(root, 'project')
  const alternate = join(root, 'alternate')
  const agent = join(root, 'codex')
  const source = join(agent, 'sessions', 'selected.jsonl')
  await Promise.all([mkdir(cwd), mkdir(alternate), mkdir(dirname(source), { recursive: true })])
  await writeFile(source, [
    { type: 'session_meta', payload: { id: 'selected', cwd } },
    ...[['user', 'Original title'], ['assistant', 'A searchable body']].map(([role, text]) =>
      ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'text', text }] } })),
  ].map(value => JSON.stringify(value)).join('\n'))
  const config = { home: root, configFile: join(root, 'agent-bridge.json'),
    agentRoots: { codex: [agent] }, projectRoots: [alternate], workspaceHubRoots: [], archiveFiles: [] }
  const visible = new Set()
  const writes = []
  const enteredFirstImport = Promise.withResolvers()
  const finishFirstImport = Promise.withResolvers()
  const options = {
    importConversation: async (record, path) => {
      writes.push({ id: record.sessionId, path })
      if (writes.length === 1) {
        enteredFirstImport.resolve()
        await finishFirstImport.promise
      }
      visible.add(record.sessionId)
      return { sessionId: record.sessionId }
    },
    canOpenConversation: id => visible.has(id),
  }
  let catalog = createCatalog(() => config, options)
  t.after(async () => { catalog.dispose(); await rm(root, { recursive: true, force: true }) })
  const { projects } = await catalog.execute('catalog', {})
  const projectId = projects.find(project => project.cwd === cwd).id
  const { sessions: [session] } = await catalog.execute('list-conversations', { projectId })
  const input = { projectId, sessionId: session.id }
  const first = await catalog.execute('preview-conversation', input)
  const stale = await catalog.execute('preview-conversation', { ...input, targetCwd: alternate })
  assert.ok(first.canImport)
  const before = Date.now()
  const pending = catalog.execute('import-conversation', { ticket: first.ticket })
  await Promise.race([enteredFirstImport.promise, pending])
  try {
    await assert.rejects(catalog.execute('import-conversation', { ticket: stale.ticket }), { status: 409 })
  } finally {
    finishFirstImport.resolve()
  }
  const original = await pending
  const reopened = await catalog.execute('preview-conversation', input)
  assert.equal(reopened.openExisting, true)
  assert.equal(reopened.lastImport.sessionId, original.sessionId)
  assert.ok(reopened.lastImport.importedAt >= before && reopened.lastImport.importedAt <= Date.now())
  assert.equal(reopened.lastImport.approximate, false)
  assert.equal(reopened.ticket, undefined)
  const reused = await catalog.execute('import-conversation', { ticket: stale.ticket })
  assert.equal(reused.sessionId, original.sessionId)
  assert.equal(reused.reused, true)
  assert.equal(writes.length, 1)

  // Backfill an old snapshot without a completion timestamp to exercise the upgrade path.
  const db = new DatabaseSync(join(root, 'agent-bridge-history', 'history.sqlite'))
  const legacyTime = before - 60_000
  try {
    db.prepare("UPDATE snapshots SET created=?,record=json_remove(record,'$.importedAt') WHERE id=?")
      .run(legacyTime, first.ticket)
  } finally {
    db.close()
  }
  catalog.dispose()
  catalog = createCatalog(() => config, options)
  const recent = await catalog.execute('list-conversations', { projectId, recent: true })
  assert.deepEqual(recent.sessions[0].lastImport, {
    sessionId: original.sessionId, importedAt: legacyTime, approximate: true,
  })
  const { matches: [hit] } = await catalog.execute('search-conversations', { projectId, query: 'searchable' })
  assert.equal(hit.lastImport.sessionId, original.sessionId)
  const jump = await catalog.execute('preview-conversation', { ...input, searchHit: hit })
  assert.equal(jump.historyLocation.turn, 1)
  assert.equal(jump.lastImport.sessionId, original.sessionId)

  const copyPreview = await catalog.execute('preview-conversation', { ...input, targetCwd: alternate, duplicate: true })
  assert.ok(copyPreview.canImport)
  const copy = await catalog.execute('import-conversation', { ticket: copyPreview.ticket, duplicate: true })
  assert.notEqual(copy.sessionId, original.sessionId)
  assert.deepEqual(writes.map(write => write.path), [cwd, alternate])
  const latest = await catalog.execute('conversation-import-status', input)
  assert.equal(latest.lastImport.sessionId, copy.sessionId)
  assert.equal(latest.lastImport.approximate, false)
  assert.ok(latest.lastImport.importedAt > legacyTime)
  const foreign = await catalog.execute('conversation-import-status', {
    ...input, projectId: projects.find(project => project.cwd === alternate).id,
  })
  assert.equal(foreign.lastImport, null)

  visible.delete(copy.sessionId)
  const fallback = await catalog.execute('conversation-import-status', input)
  assert.equal(fallback.lastImport.sessionId, original.sessionId)
  assert.equal(fallback.lastImport.importedAt, latest.lastImport.importedAt)
  assert.equal(fallback.lastImport.older, true)
  visible.delete(original.sessionId)
  const fresh = await catalog.execute('preview-conversation', input)
  assert.equal(fresh.lastImport.sessionId, null)
  assert.ok(fresh.canImport)
  assert.equal(writes.length, 2)
  const recovered = await catalog.execute('import-conversation', { ticket: fresh.ticket })
  assert.equal(writes.length, 3)
  assert.equal((await catalog.execute('conversation-import-status', input)).lastImport.sessionId, recovered.sessionId)
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
