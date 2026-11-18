import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { listProjectAssets } from '../src/assets.js'
import { readSkillPackage } from '../src/skill-package.js'
import { SkillActivationStore, SkillHandoff, findProjectRoot } from '../src/skill-handoff.js'
import { createSkillBridge } from '../src/skill-provider.js'

const run = promisify(execFile)

async function put(file, contents) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents)
}

async function makeSkill(folder, {
  name = 'native-probe',
  marker = 'RESOURCE_MARKER',
  body = 'Use the script and reference.',
} = {}) {
  await put(path.join(folder, 'SKILL.md'), `---
name: ${name}
description: Verify native skill resource loading.
---

# ${name}

${body}
`)
  await put(path.join(folder, 'references', 'marker.txt'), marker)
  await put(path.join(folder, 'assets', 'payload.txt'), 'asset payload')
  await put(path.join(folder, 'scripts', 'probe.mjs'), `import { readFile } from 'node:fs/promises'
const marker = await readFile(new URL('../references/marker.txt', import.meta.url), 'utf8')
console.log('SCRIPT_OUTPUT=' + marker.trim())
`)
  return path.join(folder, 'SKILL.md')
}

async function fixPackageTimes(folder) {
  const when = new Date('2025-01-02T03:04:05.000Z')
  const entries = await readdir(folder, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    await utimes(path.join(entry.parentPath ?? entry.path, entry.name), when, when)
  }
}

class FakeFileSystemSkillProvider {
  constructor(_ctx, _control, config) {
    this.name = config.providerName
    this.directories = config.customSkillDirs ?? []
  }

  async list() {
    const candidates = []
    for (const directory of this.directories) {
      let entries = []
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const root = path.join(directory, entry.name)
        try {
          const skill = await readSkillPackage(path.join(root, 'SKILL.md'))
          candidates.push({
            name: skill.name,
            description: skill.description,
            invocation: skill.invocation,
            source: 'custom',
            provider: this.name,
            rank: 300,
            locator: { directory: root },
            resourceBase: { kind: 'directory', path: root },
            path: path.join(root, 'SKILL.md'),
          })
        } catch {
          // Invalid entries disappear just as the official provider reports.
        }
      }
    }
    return candidates
  }

  async get(candidate) {
    const skill = await readSkillPackage(path.join(candidate.locator.directory, 'SKILL.md'), { content: true })
    return {
      name: skill.name,
      description: skill.description,
      invocation: skill.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: candidate.locator.directory },
      path: candidate.path,
      content: skill.body,
    }
  }

  async dispose() {}
}

function fakeDsh() {
  const providers = []
  const effects = []
  let invalidationCount = 0
  const skills = {
    registerProvider(create) {
      const lifecycle = new AbortController()
      const provider = create({
        signal: lifecycle.signal,
        invalidate: () => { invalidationCount++ },
      })
      const row = { provider, invalidate: () => { invalidationCount++ } }
      providers.push(row)
      return () => {
        lifecycle.abort(new Error('test provider disposed'))
        const index = providers.indexOf(row)
        if (index >= 0) providers.splice(index, 1)
      }
    },
    async list(options) {
      const entries = []
      for (const { provider } of providers) {
        const output = await provider.list(options)
        const candidates = Array.isArray(output) ? output : output?.candidates ?? []
        for (const candidate of candidates) entries.push({ candidate, provider })
      }
      entries.sort((left, right) => left.candidate.rank - right.candidate.rank)
      const winners = new Map()
      for (const entry of entries) {
        if (!winners.has(entry.candidate.name)) winners.set(entry.candidate.name, entry)
      }
      return [...winners.values()].map(({ candidate }) => {
        const { rank: _rank, locator: _locator, ...summary } = candidate
        return summary
      })
    },
    async get(name, options) {
      const summary = (await skills.list(options)).find(skill => skill.name === name)
      if (!summary) return undefined
      const entry = providers.map(provider => ({ provider, candidate: undefined }))
      for (const row of providers) {
        const output = await row.provider.list(options)
        const candidates = Array.isArray(output) ? output : output?.candidates ?? []
        const candidate = candidates.find(item => item.name === name)
        if (candidate) {
          entry.push({ provider: row.provider, candidate })
        }
      }
      const winner = entry.filter(item => item.candidate).sort((left, right) => (
        left.candidate.rank - right.candidate.rank
      ))[0]
      return winner ? await winner.provider.get(winner.candidate, options) : undefined
    },
  }
  const ctx = {
    skills,
    get(name) {
      return name === 'skills' ? skills : undefined
    },
    effect(initializer) {
      const cleanup = initializer()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup
    },
    logger: { warn() {} },
  }
  function addNative(roots, providerName = 'filesystem', rank = 100) {
    const provider = new FakeFileSystemSkillProvider(ctx, { signal: new AbortController().signal }, {
      providerName,
      customSkillDirs: roots,
    })
    const originalList = provider.list.bind(provider)
    provider.list = async options => (await originalList(options)).map(candidate => ({ ...candidate, rank }))
    skills.registerProvider(() => provider)
    return provider
  }
  function dispose() {
    while (effects.length) effects.pop()()
  }
  return { ctx, skills, addNative, dispose, invalidationCount: () => invalidationCount }
}

async function fixture(t) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-skill-handoff-')))
  t.after(async () => rm(temp, { recursive: true, force: true }))
  const projectA = path.join(temp, 'project')
  const projectB = path.join(temp, 'project-other')
  const source = path.join(projectA, '.claude', 'skills', 'native-probe')
  const storeRoot = path.join(temp, 'dsh', 'agent-bridge-skills')
  await mkdir(path.join(projectA, '.git'), { recursive: true })
  await mkdir(projectB, { recursive: true })
  await makeSkill(source)
  const scanned = await listProjectAssets({ cwd: projectA, agents: ['claude'], projectIds: [] }, {
    home: temp,
  })
  const scannedAsset = scanned.skills.find(item => item.file === path.join(source, 'SKILL.md'))
  assert.ok(scannedAsset)
  const asset = { ...scannedAsset, id: 'a'.repeat(24) }
  const dsh = fakeDsh()
  const bridge = createSkillBridge(dsh.ctx, {
    loadProvider: async () => ({ FileSystemSkillProvider: FakeFileSystemSkillProvider }),
    storeRoot,
  })
  await bridge.ready
  t.after(() => {
    bridge.dispose()
    dsh.dispose()
  })
  return {
    temp, projectA, projectB, source, storeRoot, dsh, bridge, asset,
    project: { id: 'b'.repeat(24), cwd: projectA },
    otherProject: { id: 'c'.repeat(24), cwd: projectB },
  }
}

test('copies a complete package, registers it only for project A, and runs its bundled script', async t => {
  const { projectA, projectB, storeRoot, dsh, bridge, asset, project, otherProject } = await fixture(t)
  const inspected = await bridge.inspect(project, [asset])
  assert.equal(inspected.available, true)
  assert.equal(inspected.skills[asset.id].action, 'enable')

  const preview = await bridge.preview(project, [asset])
  assert.equal(preview.items[0].action, 'enable', preview.items[0].reason)
  assert.equal(preview.items[0].state, 'available')
  assert.equal(preview.items[0].verified, false)
  assert.equal(preview.items[0].registered, false)
  assert.equal(preview.items[0].discovered, false)
  assert.deepEqual(preview.items[0].resources, { scripts: 1, references: 1, assets: 1 })
  assert.equal(preview.items[0].hasScripts, true)
  const applied = await bridge.apply(preview.ticket)
  assert.equal(applied.items[0].applied, true)
  assert.equal(applied.items[0].verified, true)

  const nested = path.join(projectA, 'src', 'nested')
  await mkdir(nested, { recursive: true })
  const aSkills = await dsh.skills.list({ cwd: nested })
  const visible = aSkills.find(skill => skill.name === 'native-probe')
  assert.equal(visible.provider, 'agent-bridge')
  assert.equal(visible.resourceBase.kind, 'directory')
  assert.deepEqual(await dsh.skills.list({ cwd: projectB }), [])
  assert.deepEqual(await dsh.skills.list({}), [])

  const definition = await dsh.skills.get('native-probe', { cwd: projectA })
  assert.match(definition.content, /Use the script and reference/)
  assert.equal(await readFile(path.join(definition.resourceBase.path, 'references', 'marker.txt'), 'utf8'), 'RESOURCE_MARKER')
  const { stdout } = await run(process.execPath, [path.join(definition.resourceBase.path, 'scripts', 'probe.mjs')])
  assert.equal(stdout.trim(), 'SCRIPT_OUTPUT=RESOURCE_MARKER')
  assert.equal(await readdir(path.join(storeRoot, 'bundles')).then(entries => entries.length), 1)
  assert.notEqual(definition.resourceBase.path, path.dirname(asset.file))
})

test('an external store update invalidates another bridge provider cache', async t => {
  const { project, asset, storeRoot, bridge } = await fixture(t)
  const otherDsh = fakeDsh()
  const other = createSkillBridge(otherDsh.ctx, {
    loadProvider: async () => ({ FileSystemSkillProvider: FakeFileSystemSkillProvider }),
    storeRoot,
  })
  t.after(() => {
    other.dispose()
    otherDsh.dispose()
  })
  await other.ready
  const before = otherDsh.invalidationCount()
  const preview = await bridge.preview(project, [asset])
  await bridge.apply(preview.ticket)
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.ok(otherDsh.invalidationCount() > before)
})

test('uses the nearest .git root and never matches a project by path prefix', async t => {
  const { projectA, temp, bridge, asset, project } = await fixture(t)
  const preview = await bridge.preview(project, [asset])
  await bridge.apply(preview.ticket)
  const nested = path.join(projectA, 'src')
  await mkdir(nested)
  assert.equal(await findProjectRoot(nested), await realpath(projectA))
  const prefix = path.join(temp, 'project-extra')
  await mkdir(prefix)
  assert.deepEqual(await bridge.inspect({ ...project, cwd: prefix }, [asset]).then(result => result.skills[asset.id].action), 'enable')
})

test('uses a .git file as the project boundary for a worktree', async t => {
  const { temp } = await fixture(t)
  const worktree = path.join(temp, 'worktree')
  const nested = path.join(worktree, 'src')
  await mkdir(nested, { recursive: true })
  await writeFile(path.join(worktree, '.git'), 'gitdir: elsewhere\n')
  assert.equal(await findProjectRoot(nested), await realpath(worktree))
})

test('rejects a preview when the project root moves before apply', async t => {
  const { projectA, project, bridge, asset } = await fixture(t)
  const preview = await bridge.preview(project, [asset])
  const moved = `${projectA}-moved`
  await rename(projectA, moved)
  await assert.rejects(bridge.apply(preview.ticket), /项目根目录已变化/)
})

test('recommends only historical names that match a discovered local package and never auto-enables', async t => {
  const { project, bridge, asset, dsh } = await fixture(t)
  const candidates = await bridge.conversationCandidates(project, ['native-probe'], [asset])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].assetId, asset.id)
  assert.equal(candidates[0].action, 'enable')
  assert.deepEqual(await bridge.conversationCandidates(project, ['not-a-local-skill'], [asset]), [])
  assert.deepEqual(await dsh.skills.list({ cwd: project.cwd }), [])
})

test('reports a user-invocable skill as manual-only without confusing it for a general handoff', async t => {
  const { project, bridge, asset } = await fixture(t)
  await put(asset.file, `---
name: native-handoff-probe
description: Manual skill.
disable-model-invocation: true
---

Manual only.
`)
  const inspected = await bridge.inspect(project, [asset])
  assert.equal(inspected.skills[asset.id].state, 'available')
  assert.equal(inspected.skills[asset.id].manualOnly, true)
  assert.match(inspected.skills[asset.id].detail, /手动/)
})

test('reads invocation policy from the effective snapshot rather than a changed source', async t => {
  const { project, bridge, asset } = await fixture(t)
  const first = await bridge.preview(project, [asset])
  await bridge.apply(first.ticket)
  await put(asset.file, `---
name: native-probe
description: Changed source policy.
disable-model-invocation: true
user-invocable: false
---

Use the script and reference.
`)
  const beforeUpdate = await bridge.inspect(project, [asset])
  assert.equal(beforeUpdate.skills[asset.id].label, 'DSH 已发现')
  assert.equal(beforeUpdate.skills[asset.id].modelInvocable, true)
  assert.equal(beforeUpdate.skills[asset.id].userInvocable, true)
  assert.equal(beforeUpdate.skills[asset.id].sourceChanged, true)

  const update = await bridge.preview(project, [asset])
  assert.equal(update.items[0].action, 'update')
  await bridge.apply(update.ticket)
  const afterUpdate = await bridge.inspect(project, [asset])
  assert.equal(afterUpdate.skills[asset.id].label, '当前模式不可调用')
  assert.equal(afterUpdate.skills[asset.id].modelInvocable, false)
  assert.equal(afterUpdate.skills[asset.id].userInvocable, false)
  assert.equal(afterUpdate.skills[asset.id].canOmitBody, false)
})

test('shows a shared DSH-native skill as callable without offering a second project copy', async t => {
  const { source, project, bridge, asset, dsh } = await fixture(t)
  dsh.addNative([path.dirname(source)])
  const shared = { ...asset, scope: 'shared' }
  const listing = await dsh.skills.list({ cwd: project.cwd })
  assert.equal(listing[0].path, asset.file)
  const inspected = await bridge.inspect(project, [shared])
  assert.equal(inspected.skills[shared.id].label, 'DSH 已发现')
  assert.equal(inspected.skills[shared.id].action, 'view')
  assert.equal(inspected.skills[shared.id].allowed, false)
})

test('offers a verified shared directory skill for explicit project activation', async t => {
  const { temp, projectA, projectB, project, otherProject, bridge, dsh } = await fixture(t)
  const sharedRoot = path.join(temp, 'shared')
  const sharedSkill = path.join(sharedRoot, 'shared-probe')
  await makeSkill(sharedSkill, { name: 'shared-probe', marker: 'SHARED_MARKER' })
  const scanned = await listProjectAssets({ cwd: projectA, agents: ['claude'], projectIds: [] }, {
    home: temp, skillRoots: [sharedRoot],
  })
  const found = scanned.skills.find(item => item.file === path.join(sharedSkill, 'SKILL.md'))
  assert.ok(found)
  assert.equal(found.scope, 'shared')
  const asset = { ...found, id: 'd'.repeat(24) }
  const inspected = await bridge.inspect(project, [asset])
  assert.equal(inspected.skills[asset.id].action, 'enable')
  assert.equal(inspected.skills[asset.id].allowed, true)
  const preview = await bridge.preview(project, [asset])
  assert.equal(preview.items[0].action, 'enable')
  const applied = await bridge.apply(preview.ticket)
  assert.equal(applied.items[0].applied, true, applied.items[0].reason)
  const visible = (await dsh.skills.list({ cwd: projectA })).find(item => item.name === 'shared-probe')
  assert.equal(visible.provider, 'agent-bridge')
  assert.notEqual(visible.resourceBase.path, sharedSkill)
  assert.equal(await readFile(path.join(visible.resourceBase.path, 'references', 'marker.txt'), 'utf8'), 'SHARED_MARKER')
  assert.equal(await dsh.skills.get('shared-probe', { cwd: projectB }), undefined)
  assert.equal((await readFile(path.join(sharedSkill, 'SKILL.md'), 'utf8')).includes('Use the script and reference'), true)
})

test('rejects invalid frontmatter and links outside the package before copying', async t => {
  const { project, bridge, asset } = await fixture(t)
  await put(asset.file, '# no frontmatter')
  let preview = await bridge.preview(project, [asset])
  assert.equal(preview.items[0].action, 'invalid')

  const outside = path.join(path.dirname(path.dirname(asset.file)), 'outside')
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(outside, 'secret.txt'), 'outside')
  await makeSkill(path.dirname(asset.file))
  await symlink(outside, path.join(path.dirname(asset.file), 'references', 'outside'), 'junction')
  preview = await bridge.preview(project, [asset])
  assert.equal(preview.items[0].action, 'invalid')
  assert.match(preview.items[0].reason, /outside|link/i)
})

test('refuses a skill package that contains credential-like files', async t => {
  const { project, bridge, asset } = await fixture(t)
  await put(path.join(path.dirname(asset.file), '.env'), 'SECRET=hidden')
  const preview = await bridge.preview(project, [asset])
  assert.equal(preview.items[0].action, 'invalid')
  assert.match(preview.items[0].reason, /credential/i)
})

test('refuses a source change after preview instead of committing a mixed snapshot', async t => {
  const { project, bridge, asset } = await fixture(t)
  const preview = await bridge.preview(project, [asset])
  await writeFile(path.join(path.dirname(asset.file), 'references', 'marker.txt'), 'CHANGED_AFTER_PREVIEW')
  const applied = await bridge.apply(preview.ticket)
  assert.equal(applied.items[0].applied, false)
  assert.match(applied.items[0].reason, /发生变化|changed/i)
})

test('preserves an existing native skill with the same name when its content differs', async t => {
  const { temp, project, bridge, asset, dsh } = await fixture(t)
  const nativeRoot = path.join(temp, 'native')
  await makeSkill(path.join(nativeRoot, 'native-probe'), { marker: 'NATIVE_DIFFERENT', body: 'Different body.' })
  dsh.addNative([nativeRoot])
  const preview = await bridge.preview(project, [asset])
  assert.equal(preview.items[0].action, 'conflict')
  assert.equal(preview.items[0].allowed, false)
  const definition = await dsh.skills.get('native-probe', { cwd: project.cwd })
  assert.match(definition.content, /Different body/)
})

test('does not treat an unreadable external provider as the same content', async t => {
  const { temp, project, bridge, asset, dsh } = await fixture(t)
  const nativeRoot = path.join(temp, 'native')
  await makeSkill(path.join(nativeRoot, 'native-probe'))
  const provider = dsh.addNative([nativeRoot])
  provider.get = async () => undefined
  const inspected = await bridge.inspect(project, [asset])
  assert.equal(inspected.skills[asset.id].label, '同名，待核对')
  const preview = await bridge.preview(project, [asset])
  assert.equal(preview.items[0].action, 'conflict')
  assert.match(preview.items[0].reason, /无法核对/)
})

test('re-verifies the active native content before reusing or omitting the body', async t => {
  const { temp, project, bridge, asset, dsh } = await fixture(t)
  const nativeRoot = path.join(temp, 'native')
  const nativeSkill = path.join(nativeRoot, 'native-probe')
  await makeSkill(nativeSkill)
  dsh.addNative([nativeRoot])

  const preview = await bridge.preview(project, [asset])
  assert.equal(preview.items[0].action, 'reuse-native')
  assert.equal(preview.items[0].state, 'active')
  assert.equal(preview.items[0].verified, true)
  await bridge.apply(preview.ticket)
  await bridge.authorizeTextOmission(project, [asset])

  await makeSkill(nativeSkill, { body: 'The native provider changed after activation.' })
  const inspected = await bridge.inspect(project, [asset])
  assert.equal(inspected.skills[asset.id].state, 'pending')
  assert.equal(inspected.skills[asset.id].verified, false)
  assert.equal(inspected.skills[asset.id].canOmitBody, false)
  assert.equal(inspected.managedSkills[0].state, 'pending')
  await assert.rejects(bridge.authorizeTextOmission(project, [asset]), /尚未确认|正文/)

  const changed = await bridge.preview(project, [asset])
  assert.equal(changed.items[0].action, 'conflict')
  assert.equal(changed.items[0].allowed, false)
  assert.match(changed.items[0].reason, /内容不同/)
})

test('does not trust another provider that takes over an active snapshot name', async t => {
  const { temp, project, bridge, asset, dsh } = await fixture(t)
  const first = await bridge.preview(project, [asset])
  await bridge.apply(first.ticket)
  const nativeRoot = path.join(temp, 'native')
  await makeSkill(path.join(nativeRoot, 'native-probe'))
  dsh.addNative([nativeRoot])

  const inspected = await bridge.inspect(project, [asset])
  assert.equal(inspected.skills[asset.id].state, 'pending')
  assert.equal(inspected.skills[asset.id].verified, false)
  assert.equal(inspected.skills[asset.id].canOmitBody, false)
  const preview = await bridge.preview(project, [asset])
  assert.equal(preview.items[0].action, 'pending')
  assert.equal(preview.items[0].allowed, false)
  await assert.rejects(bridge.authorizeTextOmission(project, [asset]), /尚未确认|正文/)
})

test('keeps managed records when the native skill view is unavailable', async t => {
  const { temp, project, bridge, asset, dsh } = await fixture(t)
  const first = await bridge.preview(project, [asset])
  await bridge.apply(first.ticket)
  const brokenRoot = path.join(temp, 'broken-native')
  await mkdir(brokenRoot, { recursive: true })
  const broken = dsh.addNative([brokenRoot])
  broken.list = async () => { throw new Error('the current mode has no skill tool') }

  const inspected = await bridge.inspect(project, [])
  assert.equal(inspected.available, false)
  assert.equal(inspected.managedSkills.length, 1)
  assert.equal(inspected.managedSkills[0].state, 'pending')
  assert.equal(inspected.managedSkills[0].canOmitBody, false)
})

test('keeps native skills pending when their invocation policy is unavailable', async t => {
  const { temp, project, bridge, asset, dsh } = await fixture(t)
  const nativeRoot = path.join(temp, 'native')
  await makeSkill(path.join(nativeRoot, 'native-probe'))
  const provider = dsh.addNative([nativeRoot])
  const originalGet = provider.get.bind(provider)
  provider.get = async candidate => {
    const definition = await originalGet(candidate)
    return { ...definition, invocation: undefined }
  }

  const preview = await bridge.preview(project, [asset])
  assert.equal(preview.items[0].action, 'pending')
  assert.equal(preview.items[0].allowed, false)
  assert.equal(preview.items[0].state, 'pending')
  assert.equal(preview.items[0].canOmitBody, false)
  assert.match(preview.items[0].reason, /调用策略/)
})

test('reuses an existing same-name native package with identical content without a second copy', async t => {
  const { temp, project, bridge, asset, dsh, storeRoot } = await fixture(t)
  const nativeRoot = path.join(temp, 'native')
  await makeSkill(path.join(nativeRoot, 'native-probe'))
  dsh.addNative([nativeRoot])
  const inspected = await bridge.inspect(project, [asset])
  assert.equal(inspected.skills[asset.id].label, '同名，待核对')
  assert.equal(inspected.skills[asset.id].verified, false)
  const preview = await bridge.preview(project, [asset])
  assert.equal(preview.items[0].action, 'reuse-native')
  const applied = await bridge.apply(preview.ticket)
  assert.equal(applied.items[0].applied, true)
  const after = await bridge.inspect(project, [asset])
  assert.equal(after.skills[asset.id].label, 'DSH 已发现')
  const listing = await dsh.skills.list({ cwd: project.cwd })
  assert.equal(listing[0].provider, 'filesystem')
  await assert.rejects(readdir(path.join(storeRoot, 'bundles')), /ENOENT/)
})

test('two real source previews cannot overwrite the first same-name activation', async t => {
  const { temp, projectA, project, storeRoot, asset } = await fixture(t)
  const secondSource = path.join(projectA, '.codex', 'skills', 'native-probe')
  await makeSkill(secondSource, { body: 'Different source body.' })
  const scanned = await listProjectAssets({ cwd: projectA, agents: ['claude', 'codex'], projectIds: [] }, {
    home: temp,
  })
  const second = scanned.skills.find(item => item.file === path.join(secondSource, 'SKILL.md'))
  assert.ok(second)
  const secondAsset = { ...second, id: 'b'.repeat(24) }
  let arrived = 0
  let releaseFirst
  let releaseSecond
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const secondGate = new Promise(resolve => { releaseSecond = resolve })
  const validate = async first => {
    arrived++
    if (arrived === 2) {
      releaseFirst()
      setTimeout(releaseSecond, 75)
    }
    await (first ? firstGate : secondGate)
  }
  const makeHandoff = first => new SkillHandoff({
    store: new SkillActivationStore(storeRoot),
    native: { async list() { return [] }, async get() { return undefined } },
    validateBundle: async () => validate(first),
    invalidate() {},
  })
  const firstHandoff = makeHandoff(true)
  const secondHandoff = makeHandoff(false)
  const firstPreview = await firstHandoff.preview(project, [asset])
  const secondPreview = await secondHandoff.preview(project, [secondAsset])
  assert.equal(firstPreview.items[0].expectedRevision, 0)
  assert.equal(secondPreview.items[0].expectedRevision, 0)
  const [firstResult, secondResult] = await Promise.all([
    firstHandoff.apply(firstPreview.ticket),
    secondHandoff.apply(secondPreview.ticket),
  ])
  assert.equal(firstResult.items[0].applied, true, firstResult.items[0].reason)
  assert.equal(secondResult.items[0].applied, false)
  assert.match(secondResult.items[0].reason, /同名但来源不同/)
  const state = await new SkillActivationStore(storeRoot).read()
  const bucket = Object.values(state.projects).find(item => item.root === projectA)
  assert.equal(bucket.activations['native-probe'].sourceFile, asset.file)
  assert.equal((await readFile(asset.file, 'utf8')).includes('Use the script and reference'), true)
})

test('an old preview cannot restore a deactivated activation', async t => {
  const { bridge, project, asset } = await fixture(t)
  const stale = await bridge.preview(project, [asset])
  const fresh = await bridge.preview(project, [asset])
  const applied = await bridge.apply(fresh.ticket)
  assert.equal(applied.items[0].applied, true)
  await bridge.deactivate(project, applied.items[0].activationId)
  const retry = await bridge.apply(stale.ticket)
  assert.equal(retry.items[0].applied, false)
  assert.match(retry.items[0].reason, /预览|变化|重新/)
})

test('repeats an activation idempotently and keeps the previous snapshot undoable', async t => {
  const { project, bridge, asset, dsh, storeRoot } = await fixture(t)
  const first = await bridge.preview(project, [asset])
  await bridge.apply(first.ticket)
  const retried = await bridge.apply(first.ticket)
  assert.equal(retried.items[0].applied, true)
  const repeatPreview = await bridge.preview(project, [asset])
  assert.equal(repeatPreview.items[0].action, 'reuse-active')
  const repeated = await bridge.apply(repeatPreview.ticket)
  assert.equal(repeated.items[0].applied, true)
  assert.equal((await readdir(path.join(storeRoot, 'bundles'))).length, 1)

  await writeFile(asset.file, (await readFile(asset.file, 'utf8')).replace('Use the script', 'Use the updated script'))
  const update = await bridge.preview(project, [asset])
  assert.equal(update.items[0].action, 'update')
  const updated = await bridge.apply(update.ticket)
  assert.equal(updated.items[0].applied, true)
  assert.match((await dsh.skills.get('native-probe', { cwd: project.cwd })).content, /updated script/)

  await bridge.undo(project, update.items[0].activationId)
  assert.match((await dsh.skills.get('native-probe', { cwd: project.cwd })).content, /Use the script/)
})

test('reuses one content snapshot across projects and after deactivation despite different source times', async t => {
  const { source, project, otherProject, bridge, asset, dsh, storeRoot } = await fixture(t)
  await fixPackageTimes(source)
  const sourcePackage = await readSkillPackage(asset.file, { content: false })
  const first = await bridge.preview(project, [asset])
  const firstApplied = await bridge.apply(first.ticket)
  const second = await bridge.preview(otherProject, [asset])
  assert.equal(second.items[0].action, 'enable')
  const secondApplied = await bridge.apply(second.ticket)
  assert.equal(secondApplied.items[0].applied, true)
  const state = await new SkillActivationStore(storeRoot).read()
  const snapshots = Object.values(state.snapshots)
  assert.equal(snapshots.length, 1)
  assert.notEqual(snapshots[0].quickHash, sourcePackage.quickHash)
  assert.equal((await readdir(path.join(storeRoot, 'bundles'))).length, 1)
  assert.equal(Object.values(state.projects).every(bucket => Object.keys(bucket.activations).length === 1), true)

  await bridge.deactivate(project, firstApplied.items[0].activationId)
  assert.match((await dsh.skills.get('native-probe', { cwd: otherProject.cwd })).content, /Use the script/)
  const again = await bridge.preview(project, [asset])
  const reenabled = await bridge.apply(again.ticket)
  assert.equal(reenabled.items[0].applied, true)
  assert.equal((await readdir(path.join(storeRoot, 'bundles'))).length, 1)
  assert.match((await dsh.skills.get('native-probe', { cwd: project.cwd })).content, /Use the script/)
})

test('still rejects a private snapshot whose content was modified', async t => {
  const { project, bridge, asset, storeRoot } = await fixture(t)
  const first = await bridge.preview(project, [asset])
  const applied = await bridge.apply(first.ticket)
  assert.equal(applied.items[0].applied, true)
  const [snapshotName] = await readdir(path.join(storeRoot, 'bundles'))
  const snapshotFile = path.join(storeRoot, 'bundles', snapshotName, 'SKILL.md')
  await writeFile(snapshotFile, `${await readFile(snapshotFile, 'utf8')}\nTAMPERED\n`)
  await bridge.deactivate(project, applied.items[0].activationId)
  const next = await bridge.preview(project, [asset])
  const rejected = await bridge.apply(next.ticket)
  assert.equal(rejected.items[0].applied, false)
  assert.match(rejected.items[0].reason, /快照|snapshot/i)
  const state = await new SkillActivationStore(storeRoot).read()
  assert.equal(Object.values(state.projects).every(bucket => Object.keys(bucket.activations).length === 0), true)
})

test('keeps an active snapshot after its source disappears and deactivation removes only the project mapping', async t => {
  const { project, bridge, asset, dsh, storeRoot } = await fixture(t)
  const preview = await bridge.preview(project, [asset])
  const applied = await bridge.apply(preview.ticket)
  await rm(path.dirname(asset.file), { recursive: true, force: true })
  const inspected = await bridge.inspect(project, [])
  const managed = inspected.managedSkills.find(item => item.dshName === 'native-probe')
  assert.equal(managed.state, 'active')
  assert.equal(managed.sourceState, 'missing')
  assert.equal(managed.sourceChanged, true)
  assert.match(managed.detail, /来源已移除/)
  assert.match((await dsh.skills.get('native-probe', { cwd: project.cwd })).content, /Use the script/)
  await bridge.deactivate(project, applied.items[0].activationId)
  assert.equal(await dsh.skills.get('native-probe', { cwd: project.cwd }), undefined)
  assert.equal((await readdir(path.join(storeRoot, 'bundles'))).length, 1)
})

test('two independent stores preserve concurrent writes for different projects', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-skill-store-concurrent-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = new SkillActivationStore(root)
  const second = new SkillActivationStore(root)
  let arrived = 0
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const waitForBoth = async () => {
    arrived++
    if (arrived === 2) release()
    await barrier
  }
  const record = name => ({
    id: `${name[0].repeat(24)}`, assetId: 'b'.repeat(24), dshName: name,
    sourceName: name, sourceFile: `D:\\${name}\\SKILL.md`, sourceRoot: `D:\\${name}`,
    contentHash: 'c'.repeat(64), quickHash: 'd'.repeat(64), mode: 'snapshot',
    snapshotId: null, previousSnapshotId: null, activatedAt: 1, updatedAt: 1,
  })
  await Promise.all([
    waitForBoth().then(() => first.recordActivations('D:\\one', [{ dshName: 'one', record: record('one') }])),
    waitForBoth().then(() => second.recordActivations('D:\\two', [{ dshName: 'two', record: record('two') }])),
  ])
  const state = await first.read()
  assert.equal(Object.keys(state.projects).length, 2)
  assert.equal(state.projects['d:\\one'].activations.one.dshName, 'one')
  assert.equal(state.projects['d:\\two'].activations.two.dshName, 'two')
})

test('one store sees another store activation and deactivation without restart', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-skill-store-visibility-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = new SkillActivationStore(root)
  const second = new SkillActivationStore(root)
  assert.deepEqual((await second.read()).projects, {})
  const record = {
    id: 'a'.repeat(24), assetId: 'b'.repeat(24), dshName: 'probe',
    sourceName: 'probe', sourceFile: 'D:\\skill\\SKILL.md', sourceRoot: 'D:\\skill',
    contentHash: 'c'.repeat(64), quickHash: 'd'.repeat(64), mode: 'snapshot',
    snapshotId: null, previousSnapshotId: null, activatedAt: 1, updatedAt: 1,
  }
  await first.recordActivations('D:\\one', [{ dshName: 'probe', record }])
  assert.equal((await second.read()).projects['d:\\one'].activations.probe.dshName, 'probe')
  await first.removeActivation('D:\\one', record.id)
  assert.deepEqual((await second.read()).projects['d:\\one'].activations, {})
  assert.deepEqual((await new SkillActivationStore(root).read()).projects['d:\\one'].activations, {})
})

test('does not let a concurrent row overwrite a same-name skill from another source', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-skill-store-name-conflict-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = new SkillActivationStore(root)
  const second = new SkillActivationStore(root)
  const base = {
    id: '1'.repeat(24), assetId: '2'.repeat(24), dshName: 'probe',
    sourceName: 'probe', sourceFile: 'D:\\one\\SKILL.md', sourceRoot: 'D:\\one',
    contentHash: '3'.repeat(64), quickHash: '4'.repeat(64), mode: 'snapshot',
    snapshotId: null, previousSnapshotId: null, activatedAt: 1, updatedAt: 1,
  }
  await first.recordActivations('D:\\one', [{ dshName: 'probe', record: base }])
  await assert.rejects(
    second.recordActivations('D:\\one', [{
      dshName: 'probe',
      record: { ...base, id: '5'.repeat(24), assetId: '6'.repeat(24), sourceFile: 'D:\\two\\SKILL.md', sourceRoot: 'D:\\two' },
    }]),
    /同名但来源不同/,
  )
  assert.equal((await new SkillActivationStore(root).read()).projects['d:\\one'].activations.probe.sourceFile, 'D:\\one\\SKILL.md')
})

test('migrates legacy state.json once and keeps the old file untouched', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-skill-store-migrate-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const record = {
    id: 'e'.repeat(24), assetId: 'f'.repeat(24), dshName: 'legacy-probe',
    sourceName: 'legacy-probe', sourceFile: 'D:\\legacy\\SKILL.md', sourceRoot: 'D:\\legacy',
    contentHash: '1'.repeat(64), quickHash: '2'.repeat(64), mode: 'snapshot',
    snapshotId: 'legacy-probe-1234567890abcdef', previousSnapshotId: null,
    activatedAt: 1, updatedAt: 1,
  }
  const snapshot = {
    id: record.snapshotId, dshName: record.dshName, path: 'D:\\legacy',
    contentHash: record.contentHash, quickHash: record.quickHash,
    fileCount: 1, bytes: 1, createdAt: 1,
  }
  const original = `${JSON.stringify({
    version: 1,
    projects: { 'd:\\legacy': { root: 'D:\\legacy', activations: { 'legacy-probe': record } } },
    snapshots: { [snapshot.id]: snapshot },
  }, null, 2)}\n`
  const legacyFile = path.join(root, 'state.json')
  await writeFile(legacyFile, original)
  const first = await new SkillActivationStore(root).read()
  assert.equal(first.projects['d:\\legacy'].activations['legacy-probe'].dshName, 'legacy-probe')
  assert.equal(await readFile(legacyFile, 'utf8'), original)
  await writeFile(legacyFile, `${JSON.stringify({
    version: 1,
    projects: { 'd:\\later': { root: 'D:\\later', activations: {} } },
    snapshots: {},
  })}\n`)
  const second = await new SkillActivationStore(root).read()
  assert.ok(second.projects['d:\\legacy'])
  assert.equal(second.projects['d:\\later'], undefined)
})

test('a failed legacy migration leaves state.json recoverable for a later retry', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-skill-store-recover-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacyFile = path.join(root, 'state.json')
  await writeFile(legacyFile, '{not valid json')
  await assert.rejects(new SkillActivationStore(root).read(), /state|JSON|启用记录/i)
  await writeFile(legacyFile, `${JSON.stringify({
    version: 1,
    projects: { 'd:\\recovered': { root: 'D:\\recovered', activations: {} } },
    snapshots: {},
  })}\n`)
  const state = await new SkillActivationStore(root).read()
  assert.ok(state.projects['d:\\recovered'])
})

test('serializes concurrent state writes and reads a durable activation record', async t => {
  const { temp } = await fixture(t)
  const root = path.join(temp, 'state')
  await Promise.all(Array.from({ length: 8 }, (_, index) => {
    const store = new SkillActivationStore(root)
    const projectRoot = path.join(temp, `P${index}`)
    const record = {
      id: `${String(index).padEnd(24, 'a')}`, assetId: 'b'.repeat(24), dshName: `probe-${index}`,
      sourceName: `probe-${index}`, sourceFile: path.join(projectRoot, 'SKILL.md'), sourceRoot: projectRoot,
      contentHash: 'c'.repeat(64), quickHash: 'd'.repeat(64), mode: 'snapshot',
      snapshotId: null, previousSnapshotId: null, activatedAt: 1, updatedAt: 1,
    }
    return store.recordActivations(projectRoot, [{ dshName: record.dshName, record }])
  }))
  const state = await new SkillActivationStore(root).read()
  assert.equal(Object.keys(state.projects).length, 8)
})
