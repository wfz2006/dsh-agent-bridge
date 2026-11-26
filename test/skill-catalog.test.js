import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { listProjectAssets, verifyAssetSource } from '../src/assets.js'
import { createCatalog } from '../src/catalog.js'
import { SkillActivationStore, SkillHandoff } from '../src/skill-handoff.js'
import { copySkillPackage, PACKAGE_MAX_BYTES, readSkillPackage } from '../src/skill-package.js'

test('marks project skill availability and omits an enabled skill body from the revised draft', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-skill-catalog-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = path.join(root, 'project')
  const skillRoot = path.join(projectRoot, '.dsh', 'skills', 'native-probe')
  await mkdir(path.join(skillRoot, 'references'), { recursive: true })
  await writeFile(path.join(skillRoot, 'SKILL.md'), `---
name: native-probe
description: Project skill.
---

UNIQUE_SKILL_BODY
`)
  await writeFile(path.join(skillRoot, 'references', 'marker.txt'), 'PROJECT_SKILL_MARKER')
  const otherRoot = path.join(projectRoot, '.dsh', 'skills', 'other-probe')
  await mkdir(otherRoot, { recursive: true })
  await writeFile(path.join(otherRoot, 'SKILL.md'), `---
name: other-probe
description: Another project skill.
---

OTHER_SKILL_BODY
`)
  const config = {
    home: root,
    configFile: path.join(root, 'agent-bridge.json'),
    projectRoots: [projectRoot],
    workspaceHubRoots: [],
    archiveFiles: [],
    agentRoots: {},
    skillRoots: [],
  }
  let active = false
  let pending = false
  let disabled = false
  let managedSkills = []
  const handoff = {
    async inspect(_project, skills) {
      return {
        available: true,
        projectRoot,
        managedSkills,
        skills: Object.fromEntries(skills.map(skill => [skill.id, {
          label: disabled ? '当前模式不可调用' : pending ? '待确认'
            : active ? 'DSH 已发现' : '可为此项目启用',
          state: disabled ? 'disabled' : pending ? 'pending' : active ? 'active' : 'available',
          action: active ? 'deactivate' : 'enable',
          allowed: true,
          current: active && !pending,
          sourceChanged: false,
          dshName: 'native-probe',
          registered: active,
          discovered: active,
          verified: active && !pending,
          disabled,
          canOmitBody: !disabled,
          modelInvocable: true,
          userInvocable: true,
          canOmitBody: true,
          detail: '完整包可复制到 DSH 私有目录。',
        }])),
      }
    },
    async authorizeTextOmission(_project, assets) {
      if (!active || pending || disabled) {
        throw Object.assign(new Error('技能尚未确认由 DSH 原生提供。'), { status: 409 })
      }
      return assets.map(asset => ({ assetId: asset.id, dshName: 'native-probe' }))
    },
    async apply() {
      active = true
      managedSkills = [{
        activationId: 'b'.repeat(24), assetId: skill.id, dshName: 'native-probe',
        sourceName: 'native-probe', sourceState: 'same', sourceChanged: false,
        state: 'active', label: 'DSH 已发现', verified: true, canUndo: false,
        detail: '当前项目已登记。',
      }]
      return { items: [{ assetId: skill.id, applied: true, verified: true }] }
    },
  }
  const catalog = createCatalog(async () => config, { skillHandoff: handoff })
  t.after(() => catalog.dispose())
  const listing = await catalog.execute('catalog', {})
  const project = listing.projects.find(item => item.cwd === projectRoot)
  assert.ok(project)
  const detail = await catalog.execute('detail', { projectId: project.id })
  const skill = detail.skills.find(item => item.name === 'native-probe')
  const other = detail.skills.find(item => item.name === 'other-probe')
  assert.ok(other)
  assert.equal(detail.skillNativeAvailable, true)
  assert.deepEqual(detail.managedSkills, [])
  assert.equal(skill.handoff.action, 'enable')

  const withExcerpt = await catalog.execute('preview', {
    projectId: project.id, assetIds: [skill.id], history: false,
  })
  assert.match(withExcerpt.prompt, /UNIQUE_SKILL_BODY/)
  assert.equal(withExcerpt.skillCandidates[0].assetId, skill.id)

  await assert.rejects(catalog.execute('preview', {
    projectId: project.id, assetIds: [skill.id], nativeSkillIds: [skill.id], history: false,
  }), { status: 409 })
  await assert.rejects(catalog.execute('preview', {
    projectId: project.id, assetIds: [skill.id], nativeSkillIds: ['f'.repeat(24)], history: false,
  }), { status: 400 })
  await assert.rejects(catalog.execute('preview', {
    projectId: project.id, assetIds: [skill.id], nativeSkillIds: [other.id], history: false,
  }), { status: 400 })
  await catalog.execute('apply-skill-activation', { ticket: 'registered' })
  const nativeOnly = await catalog.execute('preview', {
    projectId: project.id, assetIds: [skill.id], nativeSkillIds: [skill.id], history: false,
  })
  assert.match(nativeOnly.prompt, /已启用 Skill/)
  assert.match(nativeOnly.prompt, /native-probe/)
  assert.doesNotMatch(nativeOnly.prompt, /UNIQUE_SKILL_BODY/)
  assert.match(withExcerpt.prompt, /PROJECT_SKILL_MARKER|UNIQUE_SKILL_BODY/)
  const activeDetail = await catalog.execute('detail', { projectId: project.id })
  assert.equal(activeDetail.managedSkills[0].activationId, 'b'.repeat(24))
  pending = true
  await assert.rejects(catalog.execute('preview', {
    projectId: project.id, assetIds: [skill.id], nativeSkillIds: [skill.id], history: false,
  }), { status: 409 })
  pending = false
  disabled = true
  await assert.rejects(catalog.execute('preview', {
    projectId: project.id, assetIds: [skill.id], nativeSkillIds: [skill.id], history: false,
  }), { status: 409 })
  disabled = false
  const fallback = await catalog.execute('preview', {
    projectId: project.id, assetIds: [skill.id], history: false,
  })
  assert.match(fallback.prompt, /UNIQUE_SKILL_BODY/)
})

test('falls back to text-only skill status when DSH has no native skill service', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-skill-text-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const skill = path.join(root, '.claude', 'skills', 'text-only')
  await mkdir(skill, { recursive: true })
  await writeFile(path.join(skill, 'SKILL.md'), `---
name: text-only
description: Text fallback.
---

TEXT_ONLY_BODY
`)
  const config = {
    home: root,
    configFile: path.join(root, 'agent-bridge.json'),
    projectRoots: [root],
    workspaceHubRoots: [],
    archiveFiles: [],
    agentRoots: {},
    skillRoots: [],
  }
  const catalog = createCatalog(async () => config, {})
  t.after(() => catalog.dispose())
  const project = (await catalog.execute('catalog', {})).projects.find(item => item.cwd === root)
  const detail = await catalog.execute('detail', { projectId: project.id })
  const asset = detail.skills.find(item => item.name === 'text-only')
  assert.equal(detail.skillNativeAvailable, false)
  assert.equal(asset.handoff.label, '仅可带入说明')
  assert.match(asset.handoff.reason, /原生技能服务/)
  const preview = await catalog.execute('preview', { projectId: project.id, assetIds: [asset.id], history: false })
  assert.match(preview.prompt, /TEXT_ONLY_BODY/)
})

async function proofFixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-skill-proof-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = path.join(root, 'project')
  const skillRoot = path.join(projectRoot, '.claude', 'skills', 'scope-probe')
  await mkdir(path.join(projectRoot, '.git'), { recursive: true })
  await mkdir(path.join(skillRoot, 'references'), { recursive: true })
  await writeFile(path.join(skillRoot, 'SKILL.md'), `---
name: scope-probe
description: Source proof fixture.
---

In-package body.
`)
  await writeFile(path.join(skillRoot, 'references', 'marker.txt'), 'INSIDE_MARKER')
  const outside = path.join(root, 'outside', 'scope-probe')
  await mkdir(path.join(outside, 'references'), { recursive: true })
  await writeFile(path.join(outside, 'SKILL.md'), `---
name: scope-probe
description: Outside package.
---

Outside body.
`)
  await writeFile(path.join(outside, 'references', 'marker.txt'), 'OUTSIDE_MARKER')
  const storeRoot = path.join(root, 'store')
  const handoff = new SkillHandoff({
    store: new SkillActivationStore(storeRoot),
    native: { async list() { return [] }, async get() { return undefined } },
    validateBundle: async () => {},
    invalidate() {},
  })
  const project = { id: 'a'.repeat(24), cwd: projectRoot }
  const projectRecord = { cwd: projectRoot, agents: ['claude'], projectIds: [] }
  return { root, projectRoot, skillRoot, outside, storeRoot, handoff, project, projectRecord }
}

async function markerInStore(storeRoot) {
  try {
    const entries = await readdir(path.join(storeRoot, 'bundles'), { recursive: true, withFileTypes: true })
    const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath ?? entry.path, entry.name))
    for (const file of files) {
      if ((await readFile(file, 'utf8')).includes('OUTSIDE_MARKER')) return true
    }
  } catch {
    return false
  }
  return false
}

test('rejects a scanned skill directory replaced by a junction before preview', async t => {
  const { root, skillRoot, outside, storeRoot, handoff, project, projectRecord } = await proofFixture(t)
  const { skills } = await listProjectAssets(projectRecord, { home: root })
  const asset = skills.find(item => item.name === 'scope-probe')
  assert.ok(asset)
  await rename(skillRoot, path.join(root, 'retained-skill'))
  await symlink(outside, skillRoot, 'junction')
  await assert.rejects(handoff.preview(project, [asset]), /变化|授权目录|changed|outside|link|source/i)
  assert.equal(await markerInStore(storeRoot), false)
  assert.deepEqual((await handoff.store.read()).projects, {})
})

test('rejects a skill directory replaced by a junction after preview and before apply', async t => {
  const { root, skillRoot, outside, storeRoot, handoff, project, projectRecord } = await proofFixture(t)
  const { skills } = await listProjectAssets(projectRecord, { home: root })
  const asset = skills.find(item => item.name === 'scope-probe')
  const preview = await handoff.preview(project, [asset])
  await rename(skillRoot, path.join(root, 'retained-skill'))
  await symlink(outside, skillRoot, 'junction')
  const applied = await handoff.apply(preview.ticket)
  assert.equal(applied.items[0].applied, false)
  assert.match(applied.items[0].reason, /变化|授权目录|changed|outside|link|source/i)
  assert.equal(await markerInStore(storeRoot), false)
  assert.deepEqual((await handoff.store.read()).projects, {})
})

test('the package copy entry rejects file identities replaced after reading', async t => {
  const { root, projectRoot, skillRoot, outside } = await proofFixture(t)
  const asset = (await listProjectAssets({ cwd: projectRoot, agents: ['claude'], projectIds: [] }, {
    home: root,
  })).skills.find(item => item.name === 'scope-probe')
  assert.ok(asset)
  const authorization = await verifyAssetSource(asset)
  const snapshot = await readSkillPackage(asset.file, { content: true, authorization })
  const destination = path.join(root, 'copy-destination')
  await rename(skillRoot, path.join(root, 'retained-copy-source'))
  await symlink(outside, skillRoot, 'junction')
  await assert.rejects(copySkillPackage(snapshot, destination), /changed|变化|identity|source/i)
  await assert.rejects(stat(destination), { code: 'ENOENT' })
})

test('rejects hardlinked resources and oversized flat skills during package inspection', async t => {
  const { root, skillRoot } = await proofFixture(t)
  const external = path.join(root, 'external.txt')
  await writeFile(external, 'unrelated content')
  await link(external, path.join(skillRoot, 'references', 'linked.txt'))
  await assert.rejects(readSkillPackage(path.join(skillRoot, 'SKILL.md')), { code: 'unsafe-file' })
  const flat = path.join(root, 'example.md')
  await writeFile(flat, '---\nname: example\ndescription: Fixture.\n---\n')
  await truncate(flat, PACKAGE_MAX_BYTES + 1)
  await assert.rejects(readSkillPackage(flat), { code: 'package-too-large' })
})

test('still accepts a skill discovered through an explicitly allowed shared root', async t => {
  const { root, projectRoot, skillRoot, handoff, project } = await proofFixture(t)
  const sharedRoot = path.join(root, 'shared')
  const sharedSkill = path.join(sharedRoot, 'shared-probe')
  await mkdir(sharedSkill, { recursive: true })
  await writeFile(path.join(sharedSkill, 'SKILL.md'), `---
name: shared-probe
description: Allowed shared fixture.
---

Shared body.
`)
  await rename(skillRoot, path.join(root, 'retained-scope'))
  await symlink(sharedSkill, path.join(projectRoot, '.claude', 'skills', 'shared-probe'), 'junction')
  const { skills } = await listProjectAssets({ cwd: projectRoot, agents: ['claude'], projectIds: [] }, {
    home: root, skillRoots: [sharedRoot],
  })
  const asset = skills.find(item => item.name === 'shared-probe')
  assert.ok(asset)
  const preview = await handoff.preview(project, [asset])
  assert.equal(preview.items[0].action, 'enable')
})

test('reads quoted invocation keys and fails closed on unsupported YAML policy', async t => {
  const { skillRoot } = await proofFixture(t)
  const file = path.join(skillRoot, 'SKILL.md')
  const putPolicy = policy => writeFile(file, ['---', 'name: scope-probe', 'description: Fixture.', ...policy, '---', 'Body.'].join('\n'))
  await putPolicy(["'disable-model-invocation': true", 'user-invocable : false', 'metadata:', '  version: "1.0"', '  count: 2'])
  const packageInfo = await readSkillPackage(file)
  assert.deepEqual(packageInfo.invocation, { modelInvocable: false, userInvocable: false })
  assert.deepEqual({ ...packageInfo.metadata }, { version: '1.0', count: 2 })
  await putPolicy(['"disable\\u002dmodel-invocation": true'])
  assert.equal((await readSkillPackage(file)).invocation.modelInvocable, false)
  for (const policy of [
    ['settings: &policy {disable-model-invocation: true}', '<<: *policy'],
    ['disable-model-invocation: *policy'],
    ['disable-model-invocation:', '  - false'],
    ['disable-model-invocation: true', 'disable-model-invocation: false'],
  ]) {
    await putPolicy(policy)
    await assert.rejects(readSkillPackage(file), /policy|boolean|frontmatter|duplicate/i)
  }
})
