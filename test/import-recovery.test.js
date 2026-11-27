import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createCatalog } from '../src/catalog.js'
import { readConversationSnapshot, readStoredConversation } from '../src/conversation-store.js'
import { saveNativeSession } from '../src/session-import.js'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-recovery-'))
  const cwd = join(root, 'source-project')
  const oldTarget = join(root, 'old-target')
  const newTarget = join(root, 'new-target')
  const agent = join(root, 'codex')
  const source = join(agent, 'sessions', 'original.jsonl')
  await Promise.all([mkdir(cwd), mkdir(oldTarget), mkdir(newTarget), mkdir(dirname(source), { recursive: true })])
  const write = (file, title, reply) => writeFile(file, [
    { type: 'session_meta', payload: { cwd } },
    ...[['user', title], ['assistant', reply]].map(([role, text]) => ({
      type: 'response_item', payload: { type: 'message', role, content: [{ type: 'text', text }] },
    })),
  ].map(row => JSON.stringify(row)).join('\n'))
  await write(source, 'Original question', 'Reviewed answer')
  await write(join(dirname(source), 'extra.jsonl'), 'Other conversation', 'Reviewed cross-session excerpt')
  const config = { home: root, configFile: join(root, 'agent-bridge.json'), agentRoots: { codex: [agent] },
    workspaceHubRoots: [], archiveFiles: [] }
  const logs = new Map()
  const workspaces = new Map()
  const faults = {}
  const handle = log => ({ header: log.header,
    async read(start, count) { return { events: log.events.slice(start, start + count) } },
    async append(events) { log.events.push(...events) }, async flush() {}, async close() {},
  })
  const host = {
    sessions: { prepare(id, { meta }) { return { header: { id, version: 4, ...meta } } } },
    workspaces: { async create(path) {
      await faults.workspace?.()
      if (!workspaces.has(path)) workspaces.set(path, { path, sessionIds: [], async attachSession(id) {
        this.sessionIds.push(id)
      } })
      return workspaces.get(path)
    } },
    persistence: {
      async stat(id) { const log = logs.get(id); return log && { header: log.header } },
      async open(id) { return handle(logs.get(id)) },
      async create(header) {
        if (faults.create) return faults.create(header)
        assert.ok(!logs.has(header.id), 'a retry must keep the existing log')
        const log = { header, events: [] }
        logs.set(header.id, log)
        return handle(log)
      },
    },
  }
  const instances = []
  const open = () => {
    const instance = createCatalog(() => config, {
      importConversation: (record, target) => saveNativeSession(host, record, target),
      canOpenConversation: id => logs.has(id),
    })
    instances.push(instance)
    return instance
  }
  t.after(async () => {
    for (const instance of instances) instance.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const catalog = open()
  const { projects } = await catalog.execute('catalog', {})
  const projectId = projects.find(project => project.cwd === cwd).id
  const { sessions } = await catalog.execute('list-conversations', { projectId })
  const input = { projectId, sessionId: sessions.find(item => item.title === 'Original question').id }
  const other = { projectId, sessionId: sessions.find(item => item.title === 'Other conversation').id }
  return { catalog, open, config, input, other, root, cwd, oldTarget, newTarget, logs, faults,
    replaceSource: () => write(source, 'Changed after review', 'Unreviewed content') }
}

const workspaceFailure = () => { throw new Error('Workspace registry is offline') }

test('reselecting a directory after a confirmed unwritten failure imports the reviewed archive and expired excerpts', async t => {
  const f = await setup(t)
  const preview = await f.catalog.execute('preview-conversation', { ...f.input, targetCwd: f.oldTarget })
  const other = await f.catalog.execute('preview-conversation', f.other)
  const excerpts = [preview, other].map(p => ({ snapshotId: p.history.snapshotId, seq: 2, offset: 0 }))
  const review = await f.catalog.execute('preview-conversation-context', { ticket: preview.ticket, excerpts })
  assert.match(review.firstMessage, /Reviewed cross-session excerpt/)
  f.faults.workspace = workspaceFailure
  await assert.rejects(f.catalog.execute('import-conversation', { ticket: preview.ticket, contextKey: review.contextKey, excerpts }),
    { status: 503, recoveryTicket: preview.ticket })
  await assert.rejects(f.catalog.execute('retarget-failed-conversation', { ...f.input, ticket: preview.ticket, targetCwd: null }), { status: 409 })
  await assert.rejects(f.catalog.execute('preview-conversation', { ...f.input, snapshotId: '' }), { status: 409 })
  await f.catalog.execute('discard-conversation-preview', { snapshotId: other.ticket })
  await f.replaceSource()
  await rename(f.oldTarget, f.oldTarget + '-moved')
  const again = f.open()
  const pending = await again.execute('preview-conversation', f.input)
  assert.equal(pending.recoveryTicket, preview.ticket)
  assert.equal(pending.targetCwd, f.oldTarget)
  assert.equal(pending.canImport, false)
  assert.equal(pending.messages[0].text, review.firstMessage)
  const recover = { ...f.input, ticket: preview.ticket, targetCwd: f.newTarget }
  await assert.rejects(again.execute('retarget-failed-conversation', { ...recover, targetCwd: f.oldTarget }), { status: 409 })
  await assert.rejects(again.execute('retarget-failed-conversation', { ...recover, ...f.other }), { status: 409 })
  const fresh = await again.execute('retarget-failed-conversation', recover)
  assert.notEqual(fresh.ticket, preview.ticket)
  assert.equal(fresh.resumePending, false)
  assert.equal(fresh.continuationLocked, true)
  assert.equal(fresh.targetCwd, f.newTarget)
  assert.equal(fresh.messages[0].text, review.firstMessage)
  assert.equal(fresh.continuation.items[0].snapshotId, fresh.ticket)
  assert.equal(fresh.continuation.items[1].text, 'Reviewed cross-session excerpt')
  assert.equal(f.logs.size, 0)
  await assert.rejects(f.catalog.execute('import-conversation', { ticket: preview.ticket }), { status: 409 })
  await again.execute('discard-conversation-preview', { snapshotId: fresh.ticket })
  const reopened = await f.open().execute('preview-conversation', f.input)
  assert.equal(reopened.ticket, fresh.ticket)
  await mkdir(f.oldTarget)
  const final = await again.execute('preview-conversation', { ...f.input, snapshotId: fresh.ticket, targetCwd: f.oldTarget })
  assert.equal(final.continuationLocked, true)
  assert.equal(final.continuation.firstMessage, review.firstMessage)
  assert.equal(final.continuation.items[0].snapshotId, final.ticket)
  delete f.faults.workspace
  const result = await again.execute('import-conversation', { ticket: final.ticket, contextKey: final.continuation.contextKey,
    excerpts: final.continuation.items.map(({ snapshotId, seq, offset }) => ({ snapshotId, seq, offset })) })
  const log = f.logs.get(result.sessionId)
  assert.equal(log.header.cwd, f.oldTarget)
  assert.equal(log.events.find(e => e.data?.source?.kind === 'agent-bridge-context').data.content[0].text, review.firstMessage)
  assert.doesNotMatch(JSON.stringify(log.events), /Unreviewed content/)
  assert.equal((await readStoredConversation(f.config, result.sessionId)).history.snapshotId, final.ticket)
  assert.equal(f.logs.size, 1)
})

for (const partial of [false, true]) {
  test(`a ${partial ? 'partially written' : 'timed out'} DSH create stays bound to its receipt after another pre-write failure`, async t => {
    const f = await setup(t)
    const p = await f.catalog.execute('preview-conversation', f.input)
    const request = { ticket: p.ticket }
    const { sessionId } = await readConversationSnapshot(f.config, p.ticket)
    f.faults.create = header => {
      if (partial) f.logs.set(header.id, { header, events: [] })
      throw new Error('DSH did not acknowledge the create')
    }
    await assert.rejects(f.catalog.execute('import-conversation', request), e => e.status === 503 && !e.recoveryTicket)
    const again = f.open()
    f.faults.workspace = workspaceFailure
    await assert.rejects(again.execute('import-conversation', request), e => e.status === 503 && !e.recoveryTicket)
    assert.ok(!(await again.execute('preview-conversation', f.input)).recoveryTicket)
    await assert.rejects(again.execute('retarget-failed-conversation', { ...f.input, ...request, targetCwd: f.newTarget }), { status: 409 })
    delete f.faults.workspace
    delete f.faults.create
    assert.deepEqual(await again.execute('import-conversation', request), { sessionId })
    assert.equal(f.logs.size, 1)
    assert.equal(f.logs.get(sessionId).events.filter(e => e.type === 'session/title').length, 1)
  })
}

test('another plugin instance cannot retarget an earlier failure while its original ticket is being retried', async t => {
  const f = await setup(t)
  const preview = await f.catalog.execute('preview-conversation', f.input)
  const request = { ticket: preview.ticket }
  f.faults.workspace = workspaceFailure
  await assert.rejects(f.catalog.execute('import-conversation', request), { status: 503 })
  const again = f.open()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  f.faults.workspace = () => { entered.resolve(); return release.promise }
  const retry = f.catalog.execute('import-conversation', request)
  await Promise.race([entered.promise, retry])
  try {
    await assert.rejects(again.execute('retarget-failed-conversation', { ...f.input, ...request, targetCwd: f.newTarget }), { status: 409 })
    await assert.rejects(again.execute('import-conversation', request), { status: 409 })
  } finally {
    release.resolve()
    await retry
  }
  assert.equal(f.logs.size, 1)
  assert.equal((await again.execute('preview-conversation', f.input)).openExisting, true)
})

test('an explicit copy at another target waits for the partially created original to complete', async t => {
  const f = await setup(t)
  const first = await f.catalog.execute('preview-conversation', f.input)
  const copy = await f.catalog.execute('preview-conversation', { ...f.input, targetCwd: f.newTarget, duplicate: true })
  f.faults.create = header => {
    f.logs.set(header.id, { header, events: [] })
    throw new Error('DSH stopped after creating the file')
  }
  await assert.rejects(f.catalog.execute('import-conversation', { ticket: first.ticket }), { status: 503 })
  delete f.faults.create
  const again = f.open()
  const copyRequest = { ticket: copy.ticket, duplicate: true }
  await assert.rejects(again.execute('import-conversation', copyRequest), { status: 409 })
  assert.equal(f.logs.size, 1)
  const original = await f.catalog.execute('import-conversation', { ticket: first.ticket })
  const copied = await again.execute('import-conversation', copyRequest)
  assert.notEqual(copied.sessionId, original.sessionId)
  assert.equal(f.logs.size, 2)
})

test('reopening a source with two legacy alternate approvals requires the target or the actual receipt', async t => {
  const f = await setup(t)
  const old = await f.catalog.execute('preview-conversation', { ...f.input, targetCwd: f.oldTarget })
  const other = await f.catalog.execute('preview-conversation', { ...f.input, targetCwd: f.newTarget })
  const db = new DatabaseSync(join(f.root, 'agent-bridge-history', 'history.sqlite'))
  try { db.prepare("UPDATE snapshots SET state='approved' WHERE id IN (?,?)").run(old.ticket, other.ticket) }
  finally { db.close() }
  const again = f.open()
  const neutral = await again.execute('preview-conversation', f.input)
  assert.equal(neutral.resumePending, false)
  assert.equal(neutral.targetCwd, f.cwd)
  const bound = await again.execute('preview-conversation', { ...f.input, snapshotId: old.ticket })
  assert.equal(bound.ticket, old.ticket)
  const targeted = await again.execute('preview-conversation', { ...f.input, targetCwd: f.newTarget })
  assert.equal(targeted.ticket, other.ticket)
  assert.equal(f.logs.size, 0)
})

test('an older approved receipt with no recorded outcome remains retryable without offering to abandon it', async t => {
  const f = await setup(t)
  const p = await f.catalog.execute('preview-conversation', f.input)
  f.faults.workspace = workspaceFailure
  await assert.rejects(f.catalog.execute('import-conversation', { ticket: p.ticket }), { status: 503 })
  const db = new DatabaseSync(join(f.root, 'agent-bridge-history', 'history.sqlite'))
  try { db.prepare("UPDATE snapshots SET record=json_remove(record,'$.importAttempt') WHERE id=?").run(p.ticket) }
  finally { db.close() }
  const again = f.open()
  await assert.rejects(again.execute('import-conversation', { ticket: p.ticket }), e => e.status === 503 && !e.recoveryTicket)
  await assert.rejects(again.execute('retarget-failed-conversation', { ...f.input, ticket: p.ticket, targetCwd: f.newTarget }), { status: 409 })
  delete f.faults.workspace
  const result = await again.execute('import-conversation', { ticket: p.ticket })
  assert.equal(f.logs.get(result.sessionId).header.cwd, f.cwd)
})

test('a seed persisted by an older writer invalidates a previously unwritten failure', async t => {
  const f = await setup(t)
  const p = await f.catalog.execute('preview-conversation', f.input)
  f.faults.workspace = workspaceFailure
  await assert.rejects(f.catalog.execute('import-conversation', { ticket: p.ticket }), { status: 503, recoveryTicket: p.ticket })
  const { sessionId } = await readConversationSnapshot(f.config, p.ticket)
  const db = new DatabaseSync(join(f.root, 'agent-bridge-history', 'history.sqlite'))
  try {
    const seed = { header: { id: sessionId, version: 4, cwd: f.cwd }, events: [] }
    db.prepare('UPDATE snapshots SET seed=? WHERE id=?').run(JSON.stringify(seed), p.ticket)
  } finally { db.close() }
  const again = f.open()
  await assert.rejects(again.execute('retarget-failed-conversation', { ...f.input, ticket: p.ticket, targetCwd: f.newTarget }), { status: 409 })
  assert.ok(!(await again.execute('preview-conversation', f.input)).recoveryTicket)
  await assert.rejects(again.execute('import-conversation', { ticket: p.ticket }), e => e.status === 503 && !e.recoveryTicket)
})
