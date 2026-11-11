import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createCatalog } from '../src/catalog.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-archive-'))
  const projectRoots = ['project-a', 'project-b'].map(name => join(root, name))
  const configFile = join(root, 'agent-bridge.json')
  const archiveFile = join(root, 'agent-bridge-archive.sqlite')
  await Promise.all(projectRoots.map(dir => mkdir(dir)))
  await writeFile(configFile, JSON.stringify({ projectRoots }))
  await writeFile(join(projectRoots[0], 'AGENTS.md'), 'Existing project handoff context')
  const catalogs = []
  const create = () => {
    const catalog = createCatalog(async () => ({ configFile, projectRoots, agentRoots: {} }))
    catalogs.push(catalog)
    return catalog
  }
  t.after(async () => {
    for (const catalog of catalogs) catalog.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { create, projectRoots, configFile, archiveFile }
}

test('project archive validates the complete batch before writing and deduplicates idempotent requests', async t => {
  const { create, archiveFile } = await fixture(t)
  const catalog = create()
  const listing = await catalog.execute('catalog', {})
  const ids = listing.projects.map(project => project.id)
  assert.deepEqual(listing.projects.map(project => project.archived), [false, false])
  await assert.rejects(stat(archiveFile), { code: 'ENOENT' })

  await assert.rejects(catalog.execute('set-project-archive', { projectIds: [ids[0], 'invalid'], archived: true }), { status: 400 })
  await assert.rejects(catalog.execute('set-project-archive', { projectIds: [ids[0], '0'.repeat(24)], archived: true }), { status: 404 })
  await assert.rejects(catalog.execute('set-project-archive', { projectIds: [ids[0]], archived: 'true' }), { status: 400 })
  await assert.rejects(stat(archiveFile), { code: 'ENOENT' })

  const archived = await catalog.execute('set-project-archive', { projectIds: [ids[0], ids[0]], archived: true })
  assert.deepEqual(archived, { projectIds: [ids[0]], changedProjectIds: [ids[0]], archived: true, revision: listing.revision + 1 })
  assert.deepEqual(await catalog.execute('set-project-archive', { projectIds: [ids[0]], archived: true }), { ...archived, changedProjectIds: [] })
  await assert.rejects(catalog.execute('set-project-archive', { projectIds: [ids[0], '0'.repeat(24)], archived: false }), { status: 404 })
  const verified = await catalog.execute('catalog', {})
  assert.deepEqual(verified.projects.map(project => project.archived), [true, false])
})

test('archive state survives restart, merges independent catalog mutations and keeps handoffs usable', async t => {
  const { create, projectRoots, configFile } = await fixture(t)
  const first = create()
  const second = create()
  const before = await first.execute('catalog', {})
  const observedBefore = await second.execute('catalog', {})
  const [a, b] = before.projects
  const originalConfig = await readFile(configFile)

  await Promise.all([
    first.execute('set-project-archive', { projectIds: [a.id], archived: true }),
    second.execute('set-project-archive', { projectIds: [b.id], archived: true }),
  ])
  const observed = await second.execute('changes', { revision: observedBefore.revision })
  assert.equal(observed.changed, true)
  assert.ok(observed.revision > observedBefore.revision)
  assert.deepEqual((await first.execute('catalog', {})).projects.map(project => project.archived), [true, true])
  assert.deepEqual(await readFile(configFile), originalConfig)

  first.dispose()
  const restarted = create()
  const reopened = await restarted.execute('catalog', {})
  assert.deepEqual(reopened.projects.map(project => project.archived), [true, true])
  const detail = await restarted.execute('detail', { projectId: a.id })
  assert.equal(detail.project.archived, true)
  const preview = await restarted.execute('preview', { projectId: a.id, assetIds: [detail.memories[0].id] })
  const open = await restarted.execute('open', { ticket: preview.ticket })
  assert.equal(open.path, a.cwd)
  assert.match((await restarted.execute('export', { ticket: preview.ticket })).markdown, /Existing project handoff context/)
  assert.equal(await readFile(join(projectRoots[0], 'AGENTS.md'), 'utf8'), 'Existing project handoff context')

  const restored = await restarted.execute('set-project-archive', { projectIds: [a.id, b.id], archived: false })
  assert.deepEqual(restored.changedProjectIds, [a.id, b.id])
  const changed = await second.execute('changes', { revision: observed.revision, projectId: a.id })
  assert.equal(changed.changed, true)
  assert.ok(changed.revision > observed.revision)
  assert.deepEqual((await second.execute('catalog', {})).projects.map(project => project.archived), [false, false])
})

test('v0.6 archive state stays readable and migrates on first preference write', async t => {
  const { create, archiveFile } = await fixture(t)
  const catalog = create()
  const [{ id }] = (await catalog.execute('catalog', {})).projects
  const legacy = new DatabaseSync(archiveFile)
  legacy.exec(`PRAGMA application_id = ${0x44534841}; CREATE TABLE archived_projects (project_id TEXT PRIMARY KEY) STRICT`)
  legacy.prepare('INSERT INTO archived_projects (project_id) VALUES (?)').run(id)
  legacy.close()
  const old = await catalog.execute('detail', { projectId: id })
  assert.equal(old.project.archived, true)
  assert.equal(old.project.pinned, false)
  assert.equal(old.project.continuedAt, null)
  assert.equal(old.selection, null)
  const untouched = new DatabaseSync(archiveFile, { readOnly: true })
  assert.deepEqual(untouched.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['archived_projects'])
  untouched.close()

  const second = create()
  const before = await second.execute('catalog', {})
  const pinned = await catalog.execute('set-project-pin', { projectId: id, pinned: true })
  assert.equal(pinned.projectId, id)
  assert.equal(pinned.pinned, true)
  assert.equal((await second.execute('changes', { revision: before.revision })).changed, true)
  const saved = (await create().execute('detail', { projectId: id })).project
  assert.equal(saved.pinned, true)
  assert.equal(saved.archived, true)
  assert.equal(saved.continuedAt, null)
})

test('per-project selection saves independently and continuation requires a verified ticket', async t => {
  const { create, archiveFile } = await fixture(t)
  const first = create()
  const second = create()
  const listing = await second.execute('catalog', {})
  const [a, b] = listing.projects
  const detail = await first.execute('detail', { projectId: a.id })
  assert.equal(detail.selection, null)
  await assert.rejects(stat(archiveFile), { code: 'ENOENT' })
  await assert.rejects(first.execute('set-project-selection', { projectId: a.id, assetIds: ['arbitrary'], history: true }), { status: 400 })
  await assert.rejects(first.execute('set-project-selection', { projectId: '0'.repeat(24), assetIds: [], history: false }), { status: 404 })
  await assert.rejects(first.execute('set-project-pin', { projectId: a.id, pinned: 'true' }), { status: 400 })
  await assert.rejects(stat(archiveFile), { code: 'ENOENT' })

  const asset = detail.memories[0].id
  const selection = { assetIds: [asset, '1'.repeat(24)], history: false }
  assert.deepEqual(await first.execute('set-project-selection', {
    projectId: a.id, assetIds: [asset, asset, '1'.repeat(24)], history: false,
  }), { projectId: a.id, selection })
  assert.equal((await second.execute('changes', { revision: listing.revision })).changed, false)
  assert.deepEqual((await second.execute('detail', { projectId: a.id })).selection, selection)
  assert.equal((await second.execute('detail', { projectId: b.id })).selection, null)

  const preview = await first.execute('preview', { projectId: a.id, assetIds: [asset] })
  await assert.rejects(first.execute('record-project-continuation', { ticket: preview.ticket }), { status: 409 })
  assert.equal((await second.execute('catalog', {})).projects[0].continuedAt, null)
  await first.execute('open', { ticket: preview.ticket })
  const results = await Promise.all([
    first.execute('record-project-continuation', { ticket: preview.ticket }),
    first.execute('record-project-continuation', { ticket: preview.ticket }),
  ])
  assert.deepEqual(results[0], results[1])
  assert.equal(results[0].projectId, a.id)
  assert.ok(Number.isSafeInteger(results[0].continuedAt) && results[0].continuedAt > 0)
  assert.equal((await second.execute('changes', { revision: listing.revision })).changed, true)
  const reloaded = await create().execute('detail', { projectId: a.id })
  assert.equal(reloaded.project.continuedAt, results[0].continuedAt)
  assert.deepEqual(reloaded.selection, selection)
})
