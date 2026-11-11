import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
