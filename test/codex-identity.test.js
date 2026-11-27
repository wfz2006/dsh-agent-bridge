import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { createCatalog } from '../src/catalog.js'
import { approveConversation, finishConversation, readConversationSnapshot, readHistoryPage, stageConversation } from '../src/conversation-store.js'
import { changeProjectRelay } from '../src/project-archive.js'
import { readSourceEvents } from '../src/projects.js'

const thread = '0193adaa-8655-7cc2-bf09-f5c7e21a9919'
const basename = `rollout-2026-11-13T18-40-20-${thread}.jsonl`
const cli = fileURLToPath(new URL('../src/skill-cli.js', import.meta.url))

// Format used by releases through 0.10.0, independent of the current ID builder.
const hash = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24)
const legacyId = (file, id = thread) => hash('codex', file, null, id)

async function fixture(t) {
  const temp = await realpath(tmpdir())
  const root = await mkdtemp(path.join(temp, 'bridge-codex-identity-'))
  const cwd = path.join(root, 'project')
  const agent = path.join(root, 'profile')
  const native = path.join(root, 'native-sessions')
  await Promise.all([cwd, native, path.join(agent, 'archived_sessions')].map(dir => mkdir(dir, { recursive: true })))
  const config = { configFile: path.join(root, 'agent-bridge.json'), home: root, projectRoots: [cwd],
    agentRoots: { codex: [agent] }, workspaceHubRoots: [], archiveFiles: [] }
  await writeFile(config.configFile, JSON.stringify(config))
  const mount = () => createCatalog(() => config, {
    async importConversation(record) {
      await writeFile(path.join(native, record.sessionId), JSON.stringify(record.messages), { flag: 'wx' })
      return { sessionId: record.sessionId }
    },
    canOpenConversation: id => access(path.join(native, id)).then(() => true, () => false),
  })
  let catalog = mount()
  t.after(async () => {
    catalog.dispose()
    const directory = await realpath(root)
    assert.equal(path.dirname(directory), temp)
    assert.match(path.basename(directory), /^bridge-codex-identity-/)
    await rm(directory, { recursive: true, force: true })
  })
  return {
    root, cwd, agent, native, config, projectId: hash(process.platform === 'win32' ? cwd.toLowerCase() : cwd),
    execute: (action, input) => catalog.execute(action, input),
    restart() { catalog.dispose(); catalog = mount() },
  }
}

async function rollout(file, cwd, id = thread, finalAnswer = 'The second answer') {
  await mkdir(path.dirname(file), { recursive: true })
  const contents = [
    { type: 'session_meta', payload: { id, cwd } },
    ...[['user', 'Shared title'], ['assistant', 'The first answer'], ['user', 'Why?'], ['assistant', finalAnswer]]
      .map(([role, text]) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'text', text }] } })),
  ].map(row => JSON.stringify(row)).join('\n')
  await writeFile(file, contents)
}

async function archiveRollout(source, destination) {
  if (typeof zlib.zstdCompressSync === 'function') {
    await writeFile(destination + '.zst', zlib.zstdCompressSync(await readFile(source)))
    await rm(source)
    return destination + '.zst'
  }
  await rename(source, destination)
  return destination
}

async function legacyImport(f, file) {
  const sourceId = legacyId(file)
  const sessionId = randomUUID()
  const id = randomUUID()
  const archive = { kind: 'codex', file, root: f.agent, id: thread }
  await stageConversation(f.config, { id, sessionId, projectId: f.projectId, sourceId,
    sourceCwd: f.cwd, targetCwd: f.cwd, title: 'Shared title' },
  readSourceEvents(archive, { sourceCwd: f.cwd, config: f.config }), value => value)
  await approveConversation(f.config, id)
  await finishConversation(f.config, id)
  await writeFile(path.join(f.native, sessionId), 'Imported by 0.10.0')
  const { items } = await readHistoryPage(f.config, id)
  const answer = items.find(entry => entry.turn === 2 && entry.role === 'assistant')
  const source = { id: sourceId, title: 'Shared title', agent: 'codex', turn: 2, kind: 'message',
    seq: answer.seq, offset: answer.offset, hash: hash(answer.text) }
  const relayId = hash(sourceId, source.turn, source.seq, source.offset, source.hash)
  await changeProjectRelay(f.config, f.projectId, relayId, () => ({
    id: relayId, category: 'decided', text: answer.text, source,
  }))
  const { importedAt } = await readConversationSnapshot(f.config, id)
  const lastImport = { sessionId, importedAt, approximate: false }
  return { lastImport, relayId, sourceId, sessionId }
}

async function relayAnswer(f, sessionId, relayId) {
  const preview = await f.execute('preview-conversation', { projectId: f.projectId, sessionId, relayId })
  assert.equal(preview.historyLocation?.turn, 2)
  assert.notEqual(preview.relayLocationChanged, true)
  const page = await f.execute('conversation-history', { snapshotId: preview.history.snapshotId, ...preview.historyLocation })
  return page.items.find(entry => entry.seq === preview.historyLocation.seq && entry.offset === preview.historyLocation.offset)?.text
}

test('a Codex import keeps its ID, receipt and relay when its rollout is renamed and archived', async t => {
  const f = await fixture(t)
  const file = path.join(f.agent, 'sessions', '2026', '11', '13', basename)
  await rollout(file, f.cwd)
  const { sessions: [before] } = await f.execute('list-conversations', { projectId: f.projectId })
  const input = { projectId: f.projectId, sessionId: before.id }
  const preview = await f.execute('preview-conversation', input)
  const stale = await f.execute('preview-conversation', input)
  const page = await f.execute('conversation-history', { snapshotId: preview.history.snapshotId })
  const answer = page.items.find(item => item.role === 'assistant' && item.turn === 2)
  const relay = await f.execute('add-relay-item', { projectId: f.projectId, category: 'decided',
    snapshotId: preview.history.snapshotId, seq: answer.seq, offset: answer.offset })
  const { sessionId } = await f.execute('import-conversation', { ticket: preview.ticket })
  const { lastImport } = await f.execute('conversation-import-status', input)
  assert.equal(lastImport.sessionId, sessionId)
  assert.equal(lastImport.approximate, false)
  assert.ok(lastImport.importedAt > 0)
  await archiveRollout(file, path.join(f.agent, 'archived_sessions', 'renamed.jsonl'))
  f.restart()
  const { sessions: [after] } = await f.execute('list-conversations', { projectId: f.projectId })
  assert.equal(after.id, before.id)
  assert.deepEqual(after.lastImport, lastImport)
  const reopened = await f.execute('preview-conversation', input)
  assert.equal(reopened.openExisting, true)
  assert.deepEqual(reopened.lastImport, lastImport)
  assert.equal((await f.execute('import-conversation', { ticket: stale.ticket })).sessionId, sessionId)
  assert.deepEqual(await readdir(f.native), [sessionId])
  assert.equal(await relayAnswer(f, relay.source.id, relay.id), 'The second answer')
})

test('an already archived native rollout resolves the original path hash from a pre-upgrade receipt and relay', async t => {
  const f = await fixture(t)
  const file = path.join(f.agent, 'sessions', '2026', '11', '13', basename)
  await rollout(file, f.cwd)
  const legacy = await legacyImport(f, file)
  await archiveRollout(file, path.join(f.agent, 'archived_sessions', basename))
  f.restart()
  const { sessions: [session] } = await f.execute('list-conversations', { projectId: f.projectId })
  assert.deepEqual(session.lastImport, legacy.lastImport)
  assert.notEqual(session.id, legacy.sourceId)
  const input = { projectId: f.projectId, sessionId: session.id }
  const { matches: [hit] } = await f.execute('search-conversations', { projectId: f.projectId, query: 'second answer' })
  assert.deepEqual(hit.lastImport, legacy.lastImport)
  assert.equal((await f.execute('preview-conversation', input)).openExisting, true)
  const inspection = await f.execute('preview-conversation', { ...input, inspectSource: true })
  assert.equal((await f.execute('import-conversation', { ticket: inspection.ticket })).sessionId, legacy.sessionId)
  assert.deepEqual(await readdir(f.native), [legacy.sessionId])
  assert.equal(await relayAnswer(f, legacy.sourceId, legacy.relayId), 'The second answer')
  assert.equal(await relayAnswer(f, session.id, legacy.relayId), 'The second answer')
})

test('adding an already saved legacy relay excerpt preserves the original edited item', async t => {
  const f = await fixture(t)
  const file = path.join(f.agent, 'sessions', '2026', '11', '13', basename)
  await rollout(file, f.cwd)
  const legacy = await legacyImport(f, file)
  await archiveRollout(file, path.join(f.agent, 'archived_sessions', basename))
  const edited = await f.execute('update-relay-item', { projectId: f.projectId, id: legacy.relayId,
    category: 'next', text: 'Keep this edited decision' })
  const { sessions: [session] } = await f.execute('list-conversations', { projectId: f.projectId })
  const preview = await f.execute('preview-conversation', { projectId: f.projectId, sessionId: session.id, inspectSource: true })
  const added = await f.execute('add-relay-item', { projectId: f.projectId, category: 'decided',
    seq: edited.source.seq, offset: edited.source.offset, snapshotId: preview.history.snapshotId })
  assert.deepEqual(added, edited)
  assert.deepEqual((await f.execute('project-relay', { projectId: f.projectId })).items, [edited])
})

test('the Skill CLI accepts pre-upgrade IDs for an archived rollout and lists it once', async t => {
  const f = await fixture(t)
  const file = path.join(f.agent, 'sessions', '2026', '11', '13', basename)
  await rollout(file, f.cwd)
  await archiveRollout(file, path.join(f.agent, 'archived_sessions', basename))
  const invoke = args => spawnSync(process.execPath, [cli, ...args, '--project', f.cwd, '--agent', 'codex'], {
    encoding: 'utf8', env: { ...process.env, DSH_AGENT_BRIDGE_CONFIG: f.config.configFile },
  })
  const history = invoke(['history', '--session', legacyId(file), '--turn', '2'])
  assert.equal(history.status, 0, history.stderr)
  assert.deepEqual(JSON.parse(history.stdout).items.filter(item => item.kind === 'message').map(item => item.text),
    ['Why?', 'The second answer'])
  const detail = invoke(['inspect'])
  assert.equal(detail.status, 0, detail.stderr)
  assert.equal(JSON.parse(detail.stdout).conversations.length, 1)
})

test('a stale Codex index preserves a nonstandard old path only within the same configured profile and project', async t => {
  const f = await fixture(t)
  const file = path.join(f.agent, 'sessions', 'custom', 'original.jsonl')
  await rollout(file, f.cwd)
  const legacy = await legacyImport(f, file)
  await archiveRollout(file, path.join(f.agent, 'archived_sessions', 'renamed.jsonl'))
  const other = path.join(f.root, 'second-profile')
  const foreign = path.join(f.root, 'other-project')
  await mkdir(foreign)
  await rollout(path.join(other, 'sessions', 'second.jsonl'), f.cwd, thread, 'Other profile')
  await rollout(path.join(f.agent, 'sessions', 'third.jsonl'), foreign, thread, 'Other project')
  for (const root of [f.agent, other]) {
    const db = new DatabaseSync(path.join(root, 'state_5.sqlite'))
    try {
      db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT, title TEXT)')
      db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(thread, f.cwd, file, 'Shared title')
    } finally { db.close() }
  }
  f.config.agentRoots.codex.push(other)
  f.restart()
  const { sessions } = await f.execute('list-conversations', { projectId: f.projectId })
  assert.equal(sessions.length, 2)
  const { matches: [second] } = await f.execute('search-conversations', { projectId: f.projectId, query: 'Other profile' })
  assert.equal(second.lastImport, undefined)
  assert.deepEqual(sessions.find(item => item.id !== second.id).lastImport, legacy.lastImport)
  const { projects } = await f.execute('catalog', {})
  const foreignId = projects.find(item => item.cwd === foreign)?.id
  assert.ok(foreignId, 'the same native ID in a different working directory must remain discoverable')
  const { matches: [third] } = await f.execute('search-conversations', { projectId: foreignId, query: 'Other project' })
  assert.ok(third?.id)
  assert.notEqual(third.id, second.id)
  assert.equal(sessions.some(item => item.id === third.id), false)
  assert.equal(third.lastImport, undefined)
  await assert.rejects(f.execute('preview-conversation', { projectId: foreignId, sessionId: legacy.sourceId }), { status: 404 })
})

test('a reused index path cannot assign an existing receipt to a different native Codex thread', async t => {
  const f = await fixture(t)
  const file = path.join(f.agent, 'sessions', 'reused.jsonl')
  await rollout(file, f.cwd)
  await legacyImport(f, file)
  await rollout(file, f.cwd, 'another-thread', 'A new discussion')
  const db = new DatabaseSync(path.join(f.agent, 'state_5.sqlite'))
  try {
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT, title TEXT)')
    db.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(thread, f.cwd, file, 'Shared title')
  } finally { db.close() }
  f.restart()
  const result = await f.execute('search-conversations', { projectId: f.projectId, query: 'A new discussion' })
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0].lastImport, undefined)
})

test('one malformed working directory in a Codex header cannot hide the other indexed conversations', async t => {
  const f = await fixture(t)
  const good = path.join(f.agent, 'sessions', 'good.jsonl')
  const bad = path.join(f.agent, 'sessions', 'broken.jsonl')
  await rollout(good, f.cwd)
  await rollout(bad, { malformed: true }, 'bad-thread')
  const db = new DatabaseSync(path.join(f.agent, 'state_5.sqlite'))
  try {
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT)')
    const insert = db.prepare('INSERT INTO threads VALUES (?,?,?)')
    insert.run(thread, f.cwd, good)
    insert.run('bad-thread', f.cwd, bad)
  } finally { db.close() }
  const { sessions } = await f.execute('list-conversations', { projectId: f.projectId })
  assert.equal(sessions.length, 1)
  const { matches } = await f.execute('search-conversations', { projectId: f.projectId, query: 'The second answer' })
  assert.equal(matches.length, 1)
})

test('a legacy relay with no verifiable link to a live file opens its exact saved turn', async t => {
  const f = await fixture(t)
  const file = path.join(f.agent, 'sessions', 'lost-name.jsonl')
  await rollout(file, f.cwd)
  const legacy = await legacyImport(f, file)
  await rm(file)
  await rollout(path.join(f.agent, 'archived_sessions', 'other.jsonl'), f.cwd, 'unrelated', 'Different second answer')
  f.restart()
  const { sessions: [unrelated] } = await f.execute('list-conversations', { projectId: f.projectId })
  assert.equal(unrelated.lastImport, undefined)
  const result = await f.execute('preview-conversation', { projectId: f.projectId, sessionId: legacy.sourceId, relayId: legacy.relayId })
    .catch(error => ({ status: error.status }))
  assert.equal(result.historyLocation?.turn, 2, 'the saved source and turn should still open')
  assert.equal(result.canImport, false)
  assert.equal(await relayAnswer(f, legacy.sourceId, legacy.relayId), 'The second answer')
})

test('a verified old receipt stays linked after an arbitrary rename, even without a Codex index', async t => {
  const f = await fixture(t)
  const original = path.join(f.agent, 'sessions', 'nested', 'custom-name.jsonl')
  await rollout(original, f.cwd)
  const legacy = await legacyImport(f, original)
  const { sessions: [before] } = await f.execute('list-conversations', { projectId: f.projectId })
  assert.deepEqual(before.lastImport, legacy.lastImport)
  await archiveRollout(original, path.join(f.agent, 'archived_sessions', 'changed-name.jsonl'))
  f.restart()
  const { sessions: [after] } = await f.execute('list-conversations', { projectId: f.projectId })
  assert.deepEqual(after.lastImport, legacy.lastImport)
  assert.equal((await f.execute('preview-conversation', { projectId: f.projectId, sessionId: after.id })).openExisting, true)
  assert.equal(await relayAnswer(f, legacy.sourceId, legacy.relayId), 'The second answer')
})
