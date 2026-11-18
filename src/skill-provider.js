import path from 'node:path'
import {
  PROVIDER_NAME, PROVIDER_RANK, SkillActivationStore, SkillHandoff, SkillHandoffError,
  findProjectRoot, resolveSkillStoreRoot,
} from './skill-handoff.js'

function pathKey(value) {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function unavailableStatuses(skills, reason) {
  return {
    available: false,
    projectRoot: undefined,
    managedSkills: [],
    skills: Object.fromEntries(skills.map(asset => [asset.id, {
      label: '仅可带入说明',
      state: 'handoff',
      action: 'view',
      allowed: false,
      current: false,
      sourceChanged: false,
      reason,
    }])),
  }
}

async function defaultLoadProvider() {
  return import('@deepseek-ai/dsh-skill-filesystem')
}

/**
 * Register the bridge-owned filesystem provider and expose the handoff
 * lifecycle to the panel. The official DSH provider remains the parser,
 * project-root resolver, catalog contributor, and resource-base provider.
 */
export function createSkillBridge(ctx, {
  env = process.env,
  loadProvider = defaultLoadProvider,
  storeRoot = resolveSkillStoreRoot(env),
} = {}) {
  const store = new SkillActivationStore(storeRoot)
  let control
  let disposer
  let disposed = false
  let failure
  let FileSystemSkillProvider
  let revisionTimer
  let observedRevision = 0

  const native = {
    list(options) {
      if (!ctx.get?.('skills') && !ctx.skills) throw new Error('ctx.skills is unavailable')
      return ctx.skills.list(options)
    },
    get(name, options) {
      if (!ctx.get?.('skills') && !ctx.skills) throw new Error('ctx.skills is unavailable')
      return ctx.skills.get(name, options)
    },
  }

  const handoff = new SkillHandoff({
    store,
    native,
    invalidate() {
      control?.invalidate?.()
    },
    logger: ctx.logger,
    async validateBundle(directory, projectRoot, expectedName) {
      if (!FileSystemSkillProvider) throw new SkillHandoffError('native-unavailable', '官方技能加载器尚未就绪。')
      const lifecycle = new AbortController()
      const provider = new FileSystemSkillProvider(ctx, {
        signal: lifecycle.signal,
        invalidate() {},
      }, {
        providerName: 'agent-bridge-validation',
        includeDefaultRoots: false,
        customSkillDirs: [path.dirname(directory)],
        watch: false,
      })
      try {
        const output = await provider.list({ cwd: projectRoot, signal: lifecycle.signal })
        const candidates = Array.isArray(output) ? output : output?.candidates ?? []
        const candidate = candidates.find(item => (
          pathKey(item.resourceBase?.path ?? item.locator?.directory ?? '') === pathKey(directory)
        ))
        if (!candidate) throw new SkillHandoffError('invalid-package', 'DSH 未识别这个技能包。')
        const definition = await provider.get(candidate, { cwd: projectRoot, signal: lifecycle.signal })
        if (!definition || definition.name !== expectedName) {
          throw new SkillHandoffError('invalid-package', 'DSH 读取到的技能名与预览不一致。')
        }
        if (pathKey(definition.resourceBase?.path ?? '') !== pathKey(directory)) {
          throw new SkillHandoffError('invalid-package', 'DSH 未返回私有技能资源目录。')
        }
      } finally {
        lifecycle.abort(new Error('validation finished'))
        await provider.dispose().catch(() => {})
      }
    },
  })

  const ready = (async () => {
    if (!ctx.get?.('skills') && !ctx.skills) {
      throw new SkillHandoffError('native-unavailable', '当前 DSH 未提供 ctx.skills。')
    }
    const module = await loadProvider()
    FileSystemSkillProvider = module.FileSystemSkillProvider
    if (typeof FileSystemSkillProvider !== 'function') {
      throw new SkillHandoffError('native-unavailable', '官方 FileSystemSkillProvider 不可用。')
    }
    if (disposed) return
    disposer = ctx.effect(() => ctx.skills.registerProvider(providerControl => {
      control = providerControl
      const inner = new FileSystemSkillProvider(ctx, providerControl, {
        providerName: PROVIDER_NAME,
        includeDefaultRoots: false,
        customSkillDirs: [store.bundlesDir],
        watch: false,
      })
      return {
        name: PROVIDER_NAME,
        async list(options) {
          const projectRoot = await findProjectRoot(options.cwd)
          if (!projectRoot) return []
          const output = await inner.list(options)
          const candidates = Array.isArray(output) ? output : output?.candidates ?? []
          const active = handoff.activeSnapshots(await store.read(), projectRoot)
          const filtered = candidates.filter(candidate => active.has(pathKey(
            candidate.resourceBase?.path ?? candidate.locator?.directory ?? '',
          ))).map(candidate => ({
            ...candidate,
            source: PROVIDER_NAME,
            rank: PROVIDER_RANK,
          }))
          return Array.isArray(output) ? filtered : { candidates: filtered, complete: output.complete }
        },
        async get(candidate, options) {
          const projectRoot = await findProjectRoot(options.cwd)
          if (!projectRoot) return undefined
          const active = handoff.activeSnapshots(await store.read(), projectRoot)
          const directory = candidate.resourceBase?.path ?? candidate.locator?.directory
          if (!directory || !active.has(pathKey(directory))) return undefined
          return inner.get(candidate, options)
        },
      }
    }))
    observedRevision = await store.revision().catch(() => 0)
    const pollRevision = async () => {
      if (disposed) return
      try {
        const revision = await store.revision()
        if (revision !== observedRevision) {
          observedRevision = revision
          control?.invalidate?.()
        }
      } catch {
        // A host without a native skills service can keep running in text mode.
      } finally {
        if (!disposed) revisionTimer = setTimeout(pollRevision, 250)
        revisionTimer?.unref?.()
      }
    }
    revisionTimer = setTimeout(pollRevision, 250)
    revisionTimer.unref?.()
  })().catch(error => {
    failure = error
    ctx.logger?.warn?.(`agent-bridge native skills unavailable: ${error?.message ?? error}`)
  })

  async function ensure() {
    await ready
    if (failure) throw failure
  }

  const bridge = {
    ready,
    get available() {
      return !failure && Boolean(control)
    },
    get failure() {
      return failure
    },
    async inspect(project, skills) {
      try {
        await ensure()
        return await handoff.inspect(project, skills)
      } catch (error) {
        failure ??= error
        try {
          return {
            ...await handoff.inspect(project, skills),
            available: false,
          }
        } catch {
          return unavailableStatuses(skills, '当前 DSH 未提供可用的原生技能目录。')
        }
      }
    },
    async conversationCandidates(project, usedSkills, skills) {
      try {
        await ensure()
        const used = new Set((usedSkills ?? []).map(name => String(name).toLowerCase()))
        if (!used.size) return []
        const inspected = await handoff.inspect(project, skills)
        return skills.filter(asset => {
          const status = inspected.skills[asset.id]
          return status && (used.has(String(asset.name).toLowerCase())
            || used.has(String(status.dshName).toLowerCase()))
        }).slice(0, 3).map(asset => ({ assetId: asset.id, ...inspected.skills[asset.id] }))
      } catch {
        return []
      }
    },
    async preview(project, assets) {
      await ensure()
      return handoff.preview(project, assets)
    },
    async authorizeTextOmission(project, assets) {
      await ensure()
      return handoff.authorizeTextOmission(project, assets)
    },
    async apply(ticket) {
      await ensure()
      return handoff.apply(ticket)
    },
    async deactivate(project, activationId) {
      await ensure()
      return handoff.deactivate(project, activationId)
    },
    async undo(project, activationId) {
      await ensure()
      return handoff.undo(project, activationId)
    },
    async revision() {
      await ensure()
      return store.revision()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (revisionTimer) clearTimeout(revisionTimer)
      revisionTimer = undefined
      try { disposer?.() } catch { /* The provider lifecycle is already being torn down. */ }
    },
  }
  ctx.effect(() => () => bridge.dispose())
  return bridge
}
