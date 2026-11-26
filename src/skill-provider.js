import path from 'node:path'
import { readSkillPackage } from './skill-package.js'
import {
  PROVIDER_NAME, PROVIDER_RANK, SkillActivationStore, SkillHandoff, SkillHandoffError,
  findProjectRoot, resolveSkillStoreRoot,
} from './skill-handoff.js'

function pathKey(value) {
  const normalized = path.normalize(value).replace(/^\\\\\?\\/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function skillRecord(bundle) {
  return {
    name: bundle.name,
    description: bundle.description,
    invocation: bundle.invocation,
    ...(bundle.whenToUse ? { whenToUse: bundle.whenToUse } : {}),
    ...(bundle.metadata ? { metadata: bundle.metadata } : {}),
    path: bundle.skillFile,
    resourceBase: { kind: 'directory', path: bundle.sourceRoot },
    provider: PROVIDER_NAME,
    source: PROVIDER_NAME,
  }
}

async function readPrivateBundle(directory, expectedName, contentHash) {
  const bundle = await readSkillPackage(path.join(directory, 'SKILL.md'), { content: true })
  if (pathKey(bundle.sourceRoot) !== pathKey(directory)
    || pathKey(bundle.skillFile) !== pathKey(path.join(directory, 'SKILL.md'))
    || bundle.name !== expectedName || (contentHash !== undefined && bundle.contentHash !== contentHash)) {
    throw new SkillHandoffError('snapshot-invalid', '私有技能包与启用记录不一致。')
  }
  return bundle
}

function mountProvider(store, handoff, contextSignal) {
  async function projectState(options) {
    contextSignal?.throwIfAborted()
    options.signal?.throwIfAborted()
    const project = await findProjectRoot(options.cwd)
    if (!project) return
    const state = await store.read()
    return { state, active: handoff.activeSnapshots(state, project) }
  }
  async function inspectSnapshot(entry, options) {
    const directory = store.snapshotPath(entry.id)
    try {
      const bundle = await readPrivateBundle(directory, entry.dshName, entry.contentHash)
      return bundle
    } catch {
      return undefined
    } finally {
      contextSignal?.throwIfAborted()
      options.signal?.throwIfAborted()
    }
  }
  return {
    name: PROVIDER_NAME,
    async list(options = {}) {
      const project = await projectState(options)
      if (!project) return []
      const { state, active } = project
      const candidates = []
      let complete = true
      for (const entry of Object.values(state.snapshots)) {
        if (!active.has(pathKey(store.snapshotPath(entry.id)))) continue
        const bundle = await inspectSnapshot(entry, options)
        if (bundle) candidates.push({ ...skillRecord(bundle), rank: PROVIDER_RANK, locator: { id: entry.id } })
        else complete = false
      }
      return { candidates, complete }
    },
    async get(candidate, options = {}) {
      const project = await projectState(options)
      const id = candidate?.locator?.id
      if (!project || typeof id !== 'string' || !Object.hasOwn(project.state.snapshots, id)) return
      const entry = project.state.snapshots[id]
      if (entry.dshName !== candidate.name || !project.active.has(pathKey(store.snapshotPath(entry.id)))) return
      const bundle = await inspectSnapshot(entry, options)
      if (bundle) return { ...skillRecord(bundle), content: bundle.body }
    },
  }
}

function textOnly(assets) {
  const unavailable = {
    label: '仅可带入说明', state: 'handoff', action: 'view', allowed: false, current: false,
    sourceChanged: false, reason: '当前 DSH 未提供可用的原生技能目录。',
  }
  return { available: false, managedSkills: [], skills: Object.fromEntries(assets.map(asset => [asset.id, unavailable])) }
}

export function createSkillBridge(ctx, { storeRoot = resolveSkillStoreRoot() } = {}) {
  const store = new SkillActivationStore(storeRoot)
  const service = () => ctx.get?.('skills') ?? ctx.skills
  let refreshCatalog
  let unregister
  let timer
  let stopped = false
  let failure
  const handoff = new SkillHandoff({
    store,
    native: {
      list: options => service().list(options),
      get: (name, options) => service().get(name, options),
    },
    invalidate: () => refreshCatalog?.(),
    logger: ctx.logger,
    async validateBundle(directory, _project, expectedName) {
      await readPrivateBundle(directory, expectedName)
    },
  })

  try {
    const skills = service()
    if (typeof skills?.registerProvider !== 'function') {
      throw new SkillHandoffError('native-unavailable', '当前 DSH 未提供 ctx.skills.registerProvider。')
    }
    unregister = ctx.effect(() => skills.registerProvider(lifecycle => {
      refreshCatalog = () => lifecycle.invalidate()
      return mountProvider(store, handoff, lifecycle.signal)
    }))
  } catch (error) {
    failure = error
    ctx.logger?.warn?.('agent-bridge native skills unavailable: ' + (error?.message ?? error))
  }

  const ready = (async () => {
    if (failure) return
    let previous = await store.revision().catch(() => 0)
    const schedule = () => {
      if (stopped) return
      timer = setTimeout(async () => {
        try {
          const revision = await store.revision()
          if (!stopped && revision !== previous) {
            previous = revision
            refreshCatalog?.()
          }
        } catch { /* Retry on the next read when the database is available. */ }
        schedule()
      }, 250)
      timer.unref?.()
    }
    schedule()
  })()

  async function requireProvider() {
    await ready
    if (failure) throw failure
    if (stopped) throw new SkillHandoffError('native-unavailable', '原生技能目录已关闭。')
  }
  function command(method) {
    return async (...args) => {
      await requireProvider()
      return handoff[method](...args)
    }
  }

  const bridge = {
    ready,
    get available() { return !failure && !stopped && Boolean(refreshCatalog) },
    get failure() { return failure },
    async inspect(project, skills) {
      await ready
      try {
        const result = await handoff.inspect(project, skills)
        return bridge.available ? result : { ...result, available: false }
      } catch {
        return textOnly(skills)
      }
    },
    async conversationCandidates(project, usedSkills, skills) {
      try {
        await requireProvider()
        const names = new Set((usedSkills ?? []).map(name => String(name).toLowerCase()))
        if (!names.size) return []
        const { skills: statuses } = await handoff.inspect(project, skills)
        const relevant = []
        for (const { id, name } of skills) {
          const entry = statuses[id]
          if (!entry || ![name, entry.dshName].some(value => names.has(String(value).toLowerCase()))) continue
          relevant.push({ assetId: id, ...entry })
          if (relevant.length === 3) break
        }
        return relevant
      } catch {
        return []
      }
    },
    preview: command('preview'),
    authorizeTextOmission: command('authorizeTextOmission'),
    apply: command('apply'),
    deactivate: command('deactivate'),
    undo: command('undo'),
    async revision() {
      await requireProvider()
      return store.revision()
    },
    dispose() {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      refreshCatalog = undefined
      try { unregister?.() } catch { /* The host may already have disposed the registration. */ }
    },
  }
  ctx.effect(() => () => bridge.dispose())
  return bridge
}
