import { randomUUID, createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { verifyAssetSource } from './assets.js'
import {
  SkillPackageError, copySkillPackage, readSkillPackage, snapshotIdFor, sourceState,
} from './skill-package.js'

export const PROVIDER_NAME = 'agent-bridge'
export const PROVIDER_RANK = 700
const STATE_VERSION = 1
const SKILL_DATABASE_NAME = 'state.sqlite'
const SKILL_DATABASE_VERSION = 2
const SKILL_APPLICATION_ID = 0x44534853
const TICKET_LIFETIME = 10 * 60_000
const MAX_SELECTION = 8
const labels = {
  callable: 'DSH 已发现',
  enable: '可为此项目启用',
  handoff: '仅可带入说明',
  sameName: '同名，待核对',
  pending: '待确认',
  disabled: '当前模式不可调用',
}

export class SkillHandoffError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'SkillHandoffError'
    this.code = code
    this.details = details
    this.status = code.startsWith('state-') || code === 'snapshot-invalid' ? 503 : 409
  }
}

function keyFor(...values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24)
}

function pathKey(value) {
  const normalized = path.normalize(value).replace(/^\\\\\?\\/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function inside(root, file) {
  const relative = path.relative(pathKey(root), pathKey(file))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function resolveSkillStoreRoot(env = process.env, home = homedir()) {
  const configFile = env.DSH_AGENT_BRIDGE_CONFIG
    ? path.resolve(env.DSH_AGENT_BRIDGE_CONFIG)
    : path.join(path.resolve(env.DSH_HOME || path.join(home, '.dsh')), 'agent-bridge.json')
  return path.join(path.dirname(configFile), 'agent-bridge-skills')
}

export async function findProjectRoot(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return undefined
  let current
  try {
    current = await realpath(cwd)
    if (!(await lstat(current)).isDirectory()) return undefined
  } catch {
    return undefined
  }
  const start = current
  while (true) {
    try {
      const info = await lstat(path.join(current, '.git'))
      if (info.isDirectory() || info.isFile()) return current
    } catch { /* Walk up until a real .git marker or the filesystem root. */ }
    const parent = path.dirname(current)
    if (parent === current) return start
    current = parent
  }
}

function emptyState() {
  return { version: STATE_VERSION, projects: {}, snapshots: {} }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateState(value) {
  if (!object(value) || value.version !== STATE_VERSION || !object(value.projects) || !object(value.snapshots)) {
    throw new SkillHandoffError('state-invalid', '技能启用记录格式无效，未修改任何文件。')
  }
  for (const [project, bucket] of Object.entries(value.projects)) {
    if (!object(bucket) || typeof bucket.root !== 'string' || !object(bucket.activations)) {
      throw new SkillHandoffError('state-invalid', '技能项目记录格式无效。', { project })
    }
    for (const [name, record] of Object.entries(bucket.activations)) {
      if (!object(record) || typeof record.assetId !== 'string' || record.dshName !== name
        || typeof record.sourceFile !== 'string' || typeof record.sourceRoot !== 'string'
        || typeof record.contentHash !== 'string' || typeof record.quickHash !== 'string'
        || !['snapshot', 'native'].includes(record.mode)
        || (record.snapshotId !== null && typeof record.snapshotId !== 'string')
        || (record.previousSnapshotId !== null && typeof record.previousSnapshotId !== 'string')) {
        throw new SkillHandoffError('state-invalid', '技能启用项格式无效。', { project, name })
      }
    }
  }
  for (const [id, snapshot] of Object.entries(value.snapshots)) {
    if (!object(snapshot) || snapshot.id !== id || typeof snapshot.dshName !== 'string'
      || typeof snapshot.contentHash !== 'string' || typeof snapshot.quickHash !== 'string') {
      throw new SkillHandoffError('state-invalid', '技能快照记录格式无效。', { snapshot: id })
    }
  }
  return value
}

export class SkillActivationStore {
  constructor(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('Skill store root must be absolute')
    this.root = path.resolve(root)
    this.stateFile = path.join(this.root, 'state.json')
    this.databaseFile = path.join(this.root, SKILL_DATABASE_NAME)
    this.bundlesDir = path.join(this.root, 'bundles')
    this.stagingDir = path.join(this.root, 'staging')
  }

  async read() {
    const databaseExists = await this.#databaseExists()
    const legacyExists = await this.#legacyExists()
    if (!databaseExists && !legacyExists) return emptyState()
    if (databaseExists) {
      try {
        return await this.#withDatabase(false, db => {
          if (!this.#schemaReady(db)) throw this.#uninitializedDatabase()
          if (legacyExists && !this.#migrationDone(db)) throw this.#uninitializedDatabase()
          return this.#loadState(db)
        })
      } catch (error) {
        if (error?.code !== 'skill-db-uninitialized') throw error
      }
    }
    const legacy = await this.#readLegacyState()
    if (!legacy) return emptyState()
    return this.#withDatabase(true, db => this.#loadState(db), legacy)
  }

  async readDirect() {
    return this.read()
  }

  async #databaseExists() {
    try {
      const info = await lstat(this.databaseFile)
      if (!info.isFile() || info.nlink > 1) {
        throw new SkillHandoffError('state-invalid', '技能状态数据库必须是独立常规文件。')
      }
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      if (error instanceof SkillHandoffError) throw error
      throw new SkillHandoffError('state-unreadable', '无法读取技能状态数据库。', { cause: error })
    }
  }

  async #legacyExists() {
    try {
      const info = await lstat(this.stateFile)
      if (!info.isFile() || info.nlink > 1) {
        throw new SkillHandoffError('state-invalid', '旧的技能启用记录必须是独立常规文件。')
      }
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      if (error instanceof SkillHandoffError) throw error
      throw new SkillHandoffError('state-unreadable', '无法检查旧的技能启用记录。', { cause: error })
    }
  }

  async #readLegacyState() {
    let text
    try {
      const info = await lstat(this.stateFile)
      if (!info.isFile() || info.nlink > 1) {
        throw new SkillHandoffError('state-invalid', '技能启用记录必须是独立常规文件。')
      }
      text = await readFile(this.stateFile, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      if (error instanceof SkillHandoffError) throw error
      throw new SkillHandoffError('state-unreadable', '无法读取技能启用记录。', { cause: error })
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new SkillHandoffError('state-invalid', '技能启用记录不是有效 JSON。')
    }
    return validateState(parsed)
  }

  #uninitializedDatabase() {
    return Object.assign(new Error('技能状态数据库尚未初始化。'), { code: 'skill-db-uninitialized' })
  }

  async #withDatabase(write, operation, legacyState) {
    if (write) await mkdir(this.root, { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(this.databaseFile, { readOnly: !write })
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF')
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
      try {
        if (write) {
          this.#ensureSchema(db)
          if (legacyState && !this.#migrationDone(db)) this.#migrateLegacy(db, legacyState)
        } else if (!this.#schemaReady(db)) {
          throw this.#uninitializedDatabase()
        }
        const result = operation(db)
        db.exec('COMMIT')
        return result
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* SQLite may already have rolled back. */ }
        throw error
      }
    } catch (error) {
      if (error instanceof SkillHandoffError || error?.code === 'skill-db-uninitialized') throw error
      throw new SkillHandoffError(
        write ? 'state-write-failed' : 'state-unreadable',
        write ? '无法保存技能启用记录。' : '无法读取技能启用记录。',
        { cause: error },
      )
    } finally {
      db.close()
    }
  }

  #ensureSchema(db) {
    const applicationId = Number(db.prepare('PRAGMA application_id').get()?.application_id ?? 0)
    const hasTables = Boolean(db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get())
    if (applicationId === 0) {
      if (hasTables) throw new SkillHandoffError('state-invalid', '技能状态数据库不是 Agent Bridge 存储。')
      db.exec(`PRAGMA application_id = ${SKILL_APPLICATION_ID}`)
    } else if (applicationId !== SKILL_APPLICATION_ID) {
      throw new SkillHandoffError('state-invalid', '技能状态数据库不是 Agent Bridge 存储。')
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_projects (
        project_key TEXT PRIMARY KEY,
        root TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS skill_activations (
        project_key TEXT NOT NULL,
        dsh_name TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (project_key, dsh_name)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS skill_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS skill_revisions (
        project_key TEXT NOT NULL,
        dsh_name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY (project_key, dsh_name)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS skill_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
    db.prepare(`INSERT INTO skill_meta (key, value) VALUES ('schema_version', ?)
      ON CONFLICT (key) DO NOTHING`).run(String(SKILL_DATABASE_VERSION))
    db.prepare(`INSERT INTO skill_meta (key, value) VALUES ('state_revision', '0')
      ON CONFLICT (key) DO NOTHING`).run()
  }

  #schemaReady(db) {
    const applicationId = Number(db.prepare('PRAGMA application_id').get()?.application_id ?? 0)
    return applicationId === SKILL_APPLICATION_ID
      && Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'skill_activations'").get())
      && Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'skill_revisions'").get())
  }

  #migrationDone(db) {
    return Boolean(db.prepare("SELECT 1 FROM skill_meta WHERE key = 'legacy-json-migrated'").get())
  }

  #migrateLegacy(db, state) {
    const project = db.prepare(`INSERT INTO skill_projects (project_key, root) VALUES (?, ?)
      ON CONFLICT (project_key) DO UPDATE SET root = excluded.root`)
    const activation = db.prepare(`INSERT INTO skill_activations (project_key, dsh_name, record_json)
      VALUES (?, ?, ?) ON CONFLICT (project_key, dsh_name) DO NOTHING`)
    const snapshot = db.prepare(`INSERT INTO skill_snapshots (snapshot_id, snapshot_json)
      VALUES (?, ?) ON CONFLICT (snapshot_id) DO NOTHING`)
    for (const [projectKey, bucket] of Object.entries(state.projects)) {
      project.run(projectKey, bucket.root)
      for (const [name, record] of Object.entries(bucket.activations)) {
        activation.run(projectKey, name, JSON.stringify(record))
        db.prepare(`INSERT INTO skill_revisions (project_key, dsh_name, revision)
          VALUES (?, ?, 1) ON CONFLICT (project_key, dsh_name) DO NOTHING`).run(projectKey, name)
      }
    }
    for (const [id, value] of Object.entries(state.snapshots)) {
      snapshot.run(id, JSON.stringify(value))
    }
    db.prepare(`INSERT INTO skill_meta (key, value) VALUES ('legacy-json-migrated', '1')
      ON CONFLICT (key) DO NOTHING`).run()
  }

  #loadState(db) {
    const projects = {}
    for (const project of db.prepare('SELECT project_key, root FROM skill_projects ORDER BY project_key').all()) {
      projects[project.project_key] = { root: project.root, activations: {} }
    }
    for (const row of db.prepare('SELECT project_key, dsh_name, record_json FROM skill_activations').all()) {
      if (!projects[row.project_key]) continue
      projects[row.project_key].activations[row.dsh_name] = JSON.parse(row.record_json)
    }
    const snapshots = {}
    for (const row of db.prepare('SELECT snapshot_id, snapshot_json FROM skill_snapshots').all()) {
      snapshots[row.snapshot_id] = JSON.parse(row.snapshot_json)
    }
    return validateState({ version: STATE_VERSION, projects, snapshots })
  }

  #loadRevisions(db) {
    return Object.fromEntries(db.prepare('SELECT project_key, dsh_name, revision FROM skill_revisions')
      .all().map(row => [`${row.project_key}\0${row.dsh_name}`, row.revision]))
  }

  #stateRevision(db) {
    return Number(db.prepare("SELECT value FROM skill_meta WHERE key = 'state_revision'").get()?.value ?? 0)
  }

  #bumpStateRevision(db) {
    db.prepare(`INSERT INTO skill_meta (key, value) VALUES ('state_revision', '1')
      ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`).run()
  }

  #getRevision(db, projectKey, dshName) {
    return Number(db.prepare('SELECT revision FROM skill_revisions WHERE project_key = ? AND dsh_name = ?')
      .get(projectKey, dshName)?.revision ?? 0)
  }

  #bumpRevision(db, projectKey, dshName) {
    db.prepare(`INSERT INTO skill_revisions (project_key, dsh_name, revision) VALUES (?, ?, 1)
      ON CONFLICT (project_key, dsh_name) DO UPDATE SET revision = skill_revisions.revision + 1`)
      .run(projectKey, dshName)
  }

  #upsertProject(db, projectKey, root) {
    db.prepare(`INSERT INTO skill_projects (project_key, root) VALUES (?, ?)
      ON CONFLICT (project_key) DO UPDATE SET root = excluded.root`).run(projectKey, root)
  }

  #upsertActivation(db, projectKey, name, record) {
    db.prepare(`INSERT INTO skill_activations (project_key, dsh_name, record_json) VALUES (?, ?, ?)
      ON CONFLICT (project_key, dsh_name) DO UPDATE SET record_json = excluded.record_json`)
      .run(projectKey, name, JSON.stringify(record))
  }

  #upsertSnapshot(db, snapshot) {
    db.prepare(`INSERT INTO skill_snapshots (snapshot_id, snapshot_json) VALUES (?, ?)
      ON CONFLICT (snapshot_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`)
      .run(snapshot.id, JSON.stringify(snapshot))
  }

  async recordActivations(root, entries) {
    if (!Array.isArray(entries)) throw new TypeError('Skill records must be an array')
    await this.read()
    return this.#withDatabase(true, db => {
      const projectKey = pathKey(root)
      this.#upsertProject(db, projectKey, root)
      for (const entry of entries) {
        const existing = db.prepare('SELECT record_json FROM skill_activations WHERE project_key = ? AND dsh_name = ?')
          .get(projectKey, entry.dshName)
        const currentRevision = this.#getRevision(db, projectKey, entry.dshName)
        const expectedRevision = entry.expectedRevision
        if (existing) {
          const current = JSON.parse(existing.record_json)
          const sameSource = sameFile(current.sourceFile, entry.record.sourceFile)
          const sameContent = current.contentHash === entry.record.contentHash
          if (!sameSource) {
            throw new SkillHandoffError('name-conflict', '这个项目已经启用了同名但来源不同的技能，未替换原技能。')
          }
          if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
            if (sameContent) continue
            throw new SkillHandoffError('preview-stale', '技能登记已变化，请重新预览后再提交。')
          }
          if (sameContent) continue
        } else if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
          throw new SkillHandoffError('preview-stale', '技能登记已变化，请重新预览后再提交。')
        }
        this.#upsertActivation(db, projectKey, entry.dshName, entry.record)
        this.#bumpRevision(db, projectKey, entry.dshName)
        this.#bumpStateRevision(db)
        if (entry.snapshot) this.#upsertSnapshot(db, entry.snapshot)
      }
      return this.#loadState(db)
    })
  }

  async removeActivation(root, activationId) {
    await this.read()
    return this.#withDatabase(true, db => {
      const projectKey = pathKey(root)
      const rows = db.prepare('SELECT dsh_name, record_json FROM skill_activations WHERE project_key = ?').all(projectKey)
      const entry = rows.map(row => [row.dsh_name, JSON.parse(row.record_json)])
        .find(([, record]) => record.id === activationId)
      if (!entry) throw new SkillHandoffError('activation-missing', '找不到该项目的技能启用记录。')
      db.prepare('DELETE FROM skill_activations WHERE project_key = ? AND dsh_name = ?').run(projectKey, entry[0])
      this.#bumpRevision(db, projectKey, entry[0])
      this.#bumpStateRevision(db)
      return { record: entry[1], dshName: entry[0], projectRoot: root, state: this.#loadState(db) }
    })
  }

  async updateActivation(root, activationId, expected, next) {
    if (!expected || !next) throw new TypeError('Activation records are required')
    await this.read()
    return this.#withDatabase(true, db => {
      const projectKey = pathKey(root)
      const rows = db.prepare('SELECT dsh_name, record_json FROM skill_activations WHERE project_key = ?').all(projectKey)
      const entry = rows.map(row => [row.dsh_name, JSON.parse(row.record_json)])
        .find(([, record]) => record.id === activationId)
      if (!entry) throw new SkillHandoffError('activation-missing', '找不到该项目的技能启用记录。')
      if (entry[0] !== expected.dshName
        || JSON.stringify(entry[1]) !== JSON.stringify(expected)) {
        throw new SkillHandoffError('activation-changed', '技能启用记录已变化，请重新读取后再试。')
      }
      this.#upsertProject(db, projectKey, root)
      this.#upsertActivation(db, projectKey, next.dshName, next)
      this.#bumpRevision(db, projectKey, next.dshName)
      this.#bumpStateRevision(db)
      return { dshName: next.dshName, activationId: next.id, state: this.#loadState(db) }
    })
  }

  async readVersioned() {
    await this.read()
    if (!await this.#databaseExists()) return { state: emptyState(), revisions: {} }
    return this.#withDatabase(false, db => ({
      state: this.#loadState(db),
      revisions: this.#loadRevisions(db),
      revision: this.#stateRevision(db),
    }))
  }

  async skillRevision(root, dshName) {
    const { revisions } = await this.readVersioned()
    return revisions[`${pathKey(root)}\0${dshName}`] ?? 0
  }

  async revision() {
    return (await this.readVersioned()).revision ?? 0
  }

  snapshotPath(id) {
    return path.join(this.bundlesDir, id)
  }
}

function projectBucket(state, root, create = false) {
  const key = pathKey(root)
  if (!create) return state.projects[key]
  state.projects[key] ??= { root, activations: {} }
  state.projects[key].root = root
  return state.projects[key]
}

function activationId(root, name) {
  return keyFor('skill-activation', pathKey(root), name)
}

function sanitizeItem(item) {
  return {
    assetId: item.assetId,
    name: item.sourceName,
    dshName: item.dshName,
    state: item.state,
    action: item.action,
    label: item.label,
    detail: item.detail,
    reason: item.reason,
    allowed: item.allowed,
    current: item.current,
    registered: item.registered,
    discovered: item.discovered,
    verified: item.verified,
    activationId: item.activationId,
    sourceChanged: item.sourceChanged,
    expectedRevision: item.expectedRevision,
    manualOnly: item.manualOnly,
    modelInvocable: item.modelInvocable,
    userInvocable: item.userInvocable,
    disabled: item.disabled,
    canOmitBody: item.canOmitBody,
    hasScripts: item.hasScripts,
    scriptFiles: item.scriptFiles,
    fileCount: item.fileCount,
    bytes: item.bytes,
    resources: item.resources,
    scopeRoot: item.scopeRoot,
  }
}

function sameFile(first, second) {
  return typeof first === 'string' && typeof second === 'string' && pathKey(first) === pathKey(second)
}

function normalizedInvocation(invocation) {
  if (typeof invocation?.modelInvocable !== 'boolean'
    || typeof invocation?.userInvocable !== 'boolean') return undefined
  return {
    modelInvocable: invocation.modelInvocable,
    userInvocable: invocation.userInvocable,
  }
}

const unknownPolicy = {
  modelInvocable: false,
  userInvocable: false,
  manualOnly: false,
  disabled: false,
  canOmitBody: false,
}

export class SkillHandoff {
  constructor({ store, native, validateBundle, invalidate, logger = console, clock = Date.now } = {}) {
    if (!store) throw new TypeError('SkillHandoff requires a store')
    this.store = store
    this.native = native
    this.validateBundle = validateBundle
    this.invalidate = invalidate ?? (() => {})
    this.logger = logger
    this.clock = clock
    this.tickets = new Map()
  }

  async #nativeList(root) {
    if (!this.native?.list) return { ok: false, summaries: [] }
    try {
      return { ok: true, summaries: await this.native.list({ cwd: root }) }
    } catch (error) {
      this.logger.warn?.(`agent-bridge: skill lookup failed: ${error.message ?? error}`)
      return { ok: false, summaries: [] }
    }
  }

  async #sameNamedNative(item, root, summaries) {
    return summaries.find(summary => summary.name === item.dshName && summary.provider !== PROVIDER_NAME)
  }

  async #nativeSkill(summary, root) {
    if (!summary || !this.native?.get) return undefined
    try {
      const definition = await this.native.get(summary.name, { cwd: root })
      if (!definition) return undefined
      const skillPackage = definition.resourceBase?.kind === 'directory'
        ? await readSkillPackage(path.join(definition.resourceBase.path, 'SKILL.md'), { content: true })
        : undefined
      return {
        definition,
        invocation: normalizedInvocation(definition.invocation),
        package: skillPackage,
      }
    } catch {
      return undefined
    }
  }

  async #nativePackage(summary, root) {
    return (await this.#nativeSkill(summary, root))?.package
  }

  #policy(invocation) {
    const modelInvocable = invocation?.modelInvocable !== false
    const userInvocable = invocation?.userInvocable !== false
    return {
      modelInvocable,
      userInvocable,
      manualOnly: !modelInvocable && userInvocable,
      disabled: !modelInvocable && !userInvocable,
      canOmitBody: modelInvocable || userInvocable,
    }
  }

  async inspect(project, skills) {
    const root = await findProjectRoot(project.cwd)
    const state = await this.store.read()
    const native = root ? await this.#nativeList(root) : { ok: false, summaries: [] }
    const statuses = {}
    await Promise.all(skills.map(async asset => {
      statuses[asset.id] = await this.#inspectAsset(asset, root, state, native)
    }))
    const managedSkills = await this.#managedSkills(root, state, native, skills, statuses)
    return {
      available: Boolean(native.ok && root),
      projectRoot: root,
      skills: statuses,
      managedSkills,
    }
  }

  async revision() {
    return this.store.revision()
  }

  async #managedSkills(root, state, native, assets, statuses) {
    if (!root) return []
    const bucket = projectBucket(state, root)
    const result = []
    for (const [dshName, record] of Object.entries(bucket?.activations ?? {})) {
      const asset = assets.find(item => item.id === record.assetId || sameFile(item.file, record.sourceFile))
      const current = asset ? statuses[asset.id] : undefined
      const verification = await this.#verifyRecord(record, native.summaries, root)
      const verified = verification.verified
      let sourceState = current?.sourceState
      if (!sourceState) {
        sourceState = await lstat(record.sourceFile).then(info => info.isFile() ? 'changed' : 'missing').catch(() => 'missing')
      }
      const policy = verification.policy ?? unknownPolicy
      const label = !verified ? labels.pending
        : policy.disabled ? labels.disabled : labels.callable
      result.push({
        activationId: record.id,
        assetId: record.assetId,
        dshName,
        sourceName: record.sourceName,
        sourceFile: record.sourceFile,
        mode: record.mode,
        snapshotId: record.snapshotId,
        updatedAt: record.updatedAt,
        sourceState,
        sourceChanged: sourceState !== 'same',
        canUndo: Boolean(record.previousSnapshotId),
        registered: true,
        discovered: verification.discovered,
        verified,
        label,
        state: !verified ? 'pending' : policy.disabled ? 'disabled' : 'active',
        action: 'manage',
        allowed: true,
        ...policy,
        detail: !verified ? '启用记录已保存，等待 DSH 确认当前快照。'
          : sourceState === 'missing' ? '来源已移除，仍可使用私有快照。'
            : sourceState !== 'same' ? '来源有变化，当前仍使用已确认快照。'
              : policy.manualOnly ? '仅可手动调用；模型自动入口未开放。'
                : '当前项目已登记，DSH 可发现该技能。',
      })
    }
    return result.sort((left, right) => left.dshName.localeCompare(right.dshName))
  }

  async #inspectAsset(asset, root, state, native) {
    const handoff = detail => ({
      label: labels.handoff, state: 'handoff', action: 'view', allowed: false,
      current: false, sourceChanged: false, registered: false, discovered: false, verified: false, ...detail,
    })
    if (!root) return handoff({ reason: '当前项目目录不可访问，不能确认 DSH 项目范围。' })
    if (!native.ok) return handoff({ reason: '当前 DSH 未提供原生技能服务。' })

    if (asset.scope !== 'project') {
      let discovered
      let authorization
      try {
        authorization = await verifyAssetSource(asset)
        discovered = await readSkillPackage(asset.file, { content: false, authorization })
      } catch (error) {
        return handoff({ reason: error.message })
      }
      const nativeSkill = native.summaries.find(item => item.name === discovered.name)
      if (nativeSkill && sameFile(nativeSkill.path, asset.file)) {
        const effective = await this.#nativeSkill(nativeSkill, root)
        if (!effective) return handoff({ reason: 'DSH 已发现同名技能，但当前无法确认实际生效版本。' })
        if (!effective.invocation) {
          return {
            ...handoff({
              dshName: discovered.name,
              reason: 'DSH 已发现该技能，但无法确认当前生效副本的模型与手动调用策略。',
            }),
            state: 'pending',
            discovered: true,
            ...unknownPolicy,
          }
        }
        const policy = this.#policy(effective.invocation)
        return {
          label: policy.disabled ? labels.disabled : labels.callable,
          state: policy.disabled ? 'disabled' : 'native', action: 'view', allowed: false,
          current: true, sourceChanged: false, dshName: discovered.name,
          ...policy,
          invocation: effective.invocation,
          verified: true,
          discovered: true,
          registered: false,
          detail: policy.disabled
            ? '模型与手动调用均已禁用。'
            : policy.manualOnly ? '仅可手动调用；模型自动入口未开放。'
              : '由 DSH 原生来源发现，无需为项目再次复制。',
        }
      }
    }

    const bucket = projectBucket(state, root)
    const currentRecord = Object.values(bucket?.activations ?? {}).find(record => (
      record.assetId === asset.id || sameFile(record.sourceFile, asset.file)
    ))
    if (currentRecord) {
      let source = 'same'
      let authorization
      try {
        authorization = await verifyAssetSource(asset)
        source = await sourceState(currentRecord.sourceFile, currentRecord, { authorization })
      } catch {
        source = 'invalid'
      }
      const sourceChanged = source !== 'same'
      const verification = await this.#verifyRecord(currentRecord, native.summaries, root)
      if (!verification.verified) {
        return {
          label: labels.pending, state: 'pending', action: 'manage', allowed: true,
          current: false, activationId: currentRecord.id, dshName: currentRecord.dshName,
          sourceChanged, sourceState: source, ...unknownPolicy, invocation: undefined,
          registered: true, discovered: verification.discovered, verified: false,
          canUndo: Boolean(currentRecord.previousSnapshotId),
          reason: '已保存启用记录，但 DSH 当前生效版本、内容或调用策略无法确认；草稿会保留技能正文。',
        }
      }
      const policy = verification.policy
      return {
        label: policy.disabled ? labels.disabled : labels.callable,
        state: policy.disabled ? 'disabled' : 'active',
        action: source === 'missing' ? 'deactivate' : sourceChanged ? 'preview-update' : 'deactivate',
        allowed: true, current: true, activationId: currentRecord.id, dshName: currentRecord.dshName,
        sourceChanged, sourceState: source, ...policy, invocation: verification.invocation,
        registered: true, discovered: true, verified: true,
        canUndo: Boolean(currentRecord.previousSnapshotId),
        detail: source === 'missing' ? '来源已移除；当前私有快照仍可调用。'
          : sourceChanged ? '来源有变化，更新需要重新预览。'
            : policy.disabled ? '模型与手动调用均已禁用。'
              : policy.manualOnly ? '仅可手动调用；模型自动入口未开放。'
                : '当前项目已登记，DSH 可发现该技能。',
      }
    }

    let skill
    let authorization
    try {
      authorization = await verifyAssetSource(asset)
      skill = await readSkillPackage(asset.file, { content: false, authorization })
    } catch (error) {
      return handoff({ reason: error.message })
    }
    if (skill.layout !== 'directory') return handoff({ reason: '扁平 Markdown Skill 不包含完整技能包。' })

    const record = bucket?.activations?.[skill.name]
    const summary = native.summaries.find(item => item.name === skill.name)
    if (record) {
      const sourceChanged = true
      if (!sameFile(record.sourceFile, asset.file)) {
        return handoff({
          dshName: skill.name,
          activationId: record.id,
          reason: '这个项目已有同名技能；首版保留原有来源，不自动替换。',
        })
      }
      return {
        label: labels.callable, state: 'active', action: 'preview-update',
        allowed: true, current: true, activationId: record.id, dshName: skill.name, sourceChanged,
        detail: '来源有变化，更新需要重新预览。',
      }
    }

    if (summary && sameFile(summary.path, asset.file)) {
      const effective = await this.#nativeSkill(summary, root)
      if (!effective) {
        return {
          label: labels.pending, state: 'pending', action: 'view', allowed: false,
          current: false, sourceChanged: false, dshName: skill.name,
          registered: false, discovered: true, verified: false,
          reason: 'DSH 已发现同名技能，但无法读取当前生效定义。',
        }
      }
      if (!effective.invocation) {
        return {
          label: labels.pending, state: 'pending', action: 'view', allowed: false,
          current: false, sourceChanged: false, dshName: skill.name,
          registered: false, discovered: true, verified: false, ...unknownPolicy,
          reason: 'DSH 已发现该技能，但无法确认当前生效副本的模型与手动调用策略。',
        }
      }
      const policy = this.#policy(effective.invocation)
      return {
        label: policy.disabled ? labels.disabled : labels.callable,
        state: policy.disabled ? 'disabled' : 'native', action: 'view', allowed: false,
        current: true, sourceChanged: false, dshName: skill.name,
        ...policy, invocation: effective.invocation,
        registered: false, discovered: true, verified: true,
        detail: policy.disabled ? '模型与手动调用均已禁用。'
          : policy.manualOnly ? '仅可手动调用；模型自动入口未开放。'
            : '由 DSH 原生来源发现，无需再复制。',
      }
    }
    if (summary) {
      return {
        label: labels.sameName, state: 'unverified', action: 'view', allowed: false,
        current: false, sourceChanged: false, dshName: skill.name,
        registered: false, discovered: true, verified: false,
        reason: 'DSH 已有同名技能；详情中可核对内容是否相同，未核对前保留原技能。',
      }
    }
    return {
      label: labels.enable, state: 'available', action: 'enable', allowed: true,
      current: false, sourceChanged: false, dshName: skill.name,
      registered: false, discovered: false, verified: false,
      ...this.#policy(skill.invocation), invocation: skill.invocation,
      detail: skill.invocation.modelInvocable
        ? '完整包可复制到 DSH 私有目录，只对当前项目根生效。'
        : '完整包可启用，但技能声明为仅可手动调用。',
    }
  }

  async conversationCandidates(project, usedSkills) {
    const used = new Set((usedSkills ?? []).map(name => String(name).toLowerCase()))
    if (!used.size) return []
    const root = await findProjectRoot(project.cwd)
    if (!root) return []
    const { skills } = await this.inspect(project, project.skillAssets ?? [])
    return (project.skillAssets ?? []).filter(asset => {
      const status = skills[asset.id]
      return status && (used.has(String(asset.name).toLowerCase())
        || used.has(String(status.dshName).toLowerCase()))
    }).slice(0, 3).map(asset => ({ assetId: asset.id, ...status }))
  }

  async authorizeTextOmission(project, assets) {
    const inspected = await this.inspect(project, assets)
    return assets.map(asset => {
      const status = inspected.skills[asset.id]
      if (!status?.verified || !status.canOmitBody
        || !['active', 'native'].includes(status.state)) {
        throw new SkillHandoffError(
          'skill-not-active',
          `技能「${status?.dshName || asset.name}」尚未确认由当前 DSH 项目原生提供，不能省略正文。`,
        )
      }
      return {
        assetId: asset.id,
        dshName: status.dshName,
        invocation: status.invocation,
      }
    })
  }

  async preview(project, assets) {
    if (!Array.isArray(assets) || !assets.length || assets.length > MAX_SELECTION) {
      throw new SkillHandoffError('invalid-selection', `每次最多预览 ${MAX_SELECTION} 个技能。`)
    }
    const root = await findProjectRoot(project.cwd)
    if (!root) throw new SkillHandoffError('project-unavailable', '当前项目目录不可访问。')
    const native = await this.#nativeList(root)
    if (!native.ok) throw new SkillHandoffError('native-unavailable', '当前 DSH 未提供原生技能服务。')
    const { state, revisions } = await this.store.readVersioned()
    const items = []
    for (const asset of assets) {
      items.push(await this.#previewAsset(project, asset, root, state, native.summaries, revisions))
    }
    const counts = new Map()
    for (const item of items) counts.set(item.dshName, (counts.get(item.dshName) ?? 0) + 1)
    for (const item of items) {
      if ((counts.get(item.dshName) ?? 0) > 1) {
        item.action = 'conflict'
        item.allowed = false
        item.label = labels.handoff
        item.reason = '本次选择的技能包使用了同一个 DSH 技能名。'
      }
    }
    const ticket = randomUUID()
    for (const [id, record] of this.tickets) {
      if (this.clock() - record.created > TICKET_LIFETIME) this.tickets.delete(id)
    }
    if (this.tickets.size >= 40) this.tickets.delete(this.tickets.keys().next().value)
    this.tickets.set(ticket, {
      created: this.clock(), projectId: project.id, projectRoot: root, items,
    })
    return { ticket, projectRoot: root, items: items.map(sanitizeItem) }
  }

  async #previewAsset(project, asset, root, state, summaries, revisions) {
    const base = {
      assetId: asset.id, sourceName: asset.name, scopeRoot: root, activationId: null,
      sourceChanged: false, hasScripts: false, scriptFiles: [], fileCount: 0, bytes: 0,
      current: false, registered: false, discovered: false, verified: false,
      resources: { scripts: 0, references: 0, assets: 0 }, state: 'available',
    }
    let skill
    let authorization
    try {
      authorization = await verifyAssetSource(asset)
      skill = await readSkillPackage(asset.file, { content: true, authorization })
    } catch (error) {
      if (error?.code === 'ASSET_SOURCE_CHANGED') {
        throw new SkillHandoffError('source-changed', '技能来源已变化或离开了原授权目录，请刷新后重新预览。')
      }
      return { ...base, action: 'invalid', allowed: false, label: labels.handoff, reason: error.message }
    }
    const enriched = {
      ...base,
      sourceName: asset.name,
      dshName: skill.name,
      fileCount: skill.fileCount,
      bytes: skill.bytes,
      resources: skill.resources,
      hasScripts: skill.hasScripts,
      scriptFiles: skill.scriptFiles,
      ...this.#policy(skill.invocation),
      invocation: skill.invocation,
      sourceFile: asset.file,
      authorization,
      sourceRoot: skill.sourceRoot,
      contentHash: skill.contentHash,
      quickHash: skill.quickHash,
      expectedRevision: revisions[`${pathKey(root)}\0${skill.name}`] ?? 0,
    }
    if (skill.layout !== 'directory') {
      return { ...enriched, action: 'invalid', allowed: false, label: labels.handoff,
        reason: '只有目录技能包可以完整启用。' }
    }

    const bucket = projectBucket(state, root)
    const record = bucket?.activations?.[skill.name]
    const summary = summaries.find(item => item.name === skill.name)
    if (record) {
      enriched.activationId = record.id
      if (!sameFile(record.sourceFile, asset.file)) {
        return { ...enriched, action: 'conflict', allowed: false, label: labels.handoff,
          reason: '这个项目已有同名技能；首版保留原有来源，不自动替换。' }
      }
      if (record.mode === 'native') {
        const nativeRecord = await this.#sameNamedNative(enriched, root, summaries)
        if (nativeRecord) {
          const effective = await this.#nativeSkill(nativeRecord, root)
          if (effective?.package?.contentHash === skill.contentHash) {
            if (!effective.invocation) {
              return { ...enriched, ...unknownPolicy, action: 'pending', allowed: false,
                label: labels.pending, state: 'pending', current: true, verified: false,
                discovered: true, registered: true,
                reason: '同名同款原生技能已发现，但无法确认当前生效副本的调用策略；草稿会保留正文。' }
            }
            const policy = this.#policy(effective.invocation)
            return {
              ...enriched, ...policy, invocation: effective.invocation,
              action: policy.disabled ? 'native-disabled' : 'reuse-active',
              allowed: !policy.disabled,
              label: policy.disabled ? labels.disabled : labels.callable,
              state: policy.disabled ? 'disabled' : 'active',
              current: true, verified: true, discovered: true, registered: true,
              detail: policy.disabled ? '同名同款原生技能的模型与手动调用均已禁用。'
                : '当前项目继续复用相同的 DSH 原生技能。',
            }
          }
          return { ...enriched, action: 'conflict', allowed: false, label: labels.handoff,
            reason: 'DSH 的同名原生技能仍在且内容不同；首版保留原生技能。' }
        }
        return { ...enriched, action: 'enable', allowed: true, label: labels.enable,
          current: false, detail: '之前的同名原生技能已不可用；可保存当前完整包。' }
      }
      if (record.contentHash === skill.contentHash) {
        const verification = await this.#verifyRecord(record, summaries, root)
        if (!verification.verified) {
          return { ...enriched, ...unknownPolicy, action: 'pending', allowed: false,
            label: labels.pending, state: 'pending', current: true, registered: true,
            discovered: verification.discovered, verified: false,
            reason: 'DSH 当前生效版本、内容或调用策略与已确认记录不一致；草稿会保留技能正文。' }
        }
        const policy = verification.policy
        return {
          ...enriched, ...policy, invocation: verification.invocation,
          action: policy.disabled ? 'native-disabled' : 'reuse-active',
          allowed: !policy.disabled,
          label: policy.disabled ? labels.disabled : labels.callable,
          state: policy.disabled ? 'disabled' : 'active',
          current: true, registered: true, discovered: true, verified: true,
          detail: policy.disabled ? '当前快照的模型与手动调用均已禁用。'
            : '当前项目已经使用相同内容，不会重复安装。',
        }
      }
      const verification = await this.#verifyRecord(record, summaries, root)
      return {
        ...enriched, action: 'update', allowed: true,
        label: verification.verified ? labels.callable : labels.pending,
        state: verification.verified ? 'active' : 'pending',
        current: verification.verified, sourceChanged: true, registered: true,
        discovered: verification.discovered, verified: verification.verified,
        detail: verification.verified
          ? '将保存新快照并切换；上一份可撤销。'
          : '当前生效版本、内容或调用策略无法确认；仍可重新预览并保存当前来源。',
      }
    }

    const exactNative = summaries.find(summary => sameFile(summary.path, asset.file))
    if (exactNative) {
      const effective = await this.#nativeSkill(exactNative, root)
      if (!effective) {
        return { ...enriched, action: 'conflict', allowed: false, label: labels.pending,
          reason: 'DSH 已发现该技能，但无法读取当前生效定义。' }
      }
      if (!effective.invocation) {
        return { ...enriched, ...unknownPolicy, action: 'pending', allowed: false,
          label: labels.pending, state: 'pending', current: true, verified: false,
          discovered: true, registered: false,
          reason: 'DSH 已发现该技能，但无法确认当前生效副本的模型与手动调用策略。' }
      }
      const policy = this.#policy(effective.invocation)
      return {
        ...enriched, ...policy, invocation: effective.invocation,
        action: 'native', allowed: false,
        label: policy.disabled ? labels.disabled : labels.callable,
        state: policy.disabled ? 'disabled' : 'native',
        current: true, verified: true, discovered: true, registered: false,
        detail: policy.disabled ? '模型与手动调用均已禁用。'
          : '这份技能已由 DSH 原生发现，不需要再复制。',
      }
    }
    const conflict = await this.#sameNamedNative(enriched, root, summaries)
    if (conflict) {
      const effective = await this.#nativeSkill(conflict, root)
      if (effective?.package?.contentHash === skill.contentHash) {
        if (!effective.invocation) {
          return { ...enriched, ...unknownPolicy, action: 'pending', allowed: false,
            label: labels.pending, state: 'pending', current: true, verified: false,
            discovered: true, registered: false,
            reason: '同名同款原生技能已发现，但无法确认当前生效副本的调用策略；草稿会保留正文。' }
        }
        const policy = this.#policy(effective.invocation)
        return {
          ...enriched, ...policy, invocation: effective.invocation,
          action: policy.disabled ? 'native-disabled' : 'reuse-native',
          allowed: !policy.disabled,
          label: policy.disabled ? labels.disabled : labels.callable,
          state: policy.disabled ? 'disabled' : 'active',
          current: true, verified: true, discovered: true, registered: false,
          detail: policy.disabled ? '同名同款原生技能的模型与手动调用均已禁用。'
            : `复用已有的同名同款技能（${conflict.provider}）。`,
        }
      }
      return { ...enriched, action: 'conflict', allowed: false, label: labels.handoff,
        reason: effective
          ? 'DSH 已有同名但内容不同的技能；首版保留原技能，不覆盖也不自动改名。'
          : 'DSH 已有同名技能，但内容无法核对；不能当作同款复用。' }
    }
    return { ...enriched, action: 'enable', allowed: true, label: labels.enable,
      state: 'available', current: false,
      detail: '将保存完整包，只对当前 DSH 项目根生效；调用仍受当前模式权限限制。' }
  }

  async apply(ticketId) {
    const ticket = this.tickets.get(ticketId)
    if (!ticket || this.clock() - ticket.created > TICKET_LIFETIME) {
      throw new SkillHandoffError('ticket-expired', '技能预览已过期，请重新预览。')
    }
    if (ticket.result) return ticket.result
    if (ticket.pending) return ticket.pending
    ticket.pending = (async () => {
      const state = await this.store.read()
      const root = await findProjectRoot(ticket.projectRoot)
      if (!root || pathKey(root) !== pathKey(ticket.projectRoot)) {
        throw new SkillHandoffError('project-changed', '项目根目录已变化，请重新预览。')
      }
      const native = await this.#nativeList(root)
      if (!native.ok) throw new SkillHandoffError('native-unavailable', '当前 DSH 未提供原生技能服务。')
      const results = []
      const drafts = []
      for (const item of ticket.items) {
        if (!item.allowed || ['handoff', 'invalid', 'native', 'conflict'].includes(item.action)) {
          results.push({ ...sanitizeItem(item), applied: false, verified: false, reason: item.reason })
          continue
        }
        let result
        try {
          result = await this.#applyItem(item, root, state, native.summaries)
          if (result.draft) drafts.push({ draft: result.draft, result: result.result })
          results.push(result.result)
        } catch (error) {
          if (error instanceof SkillPackageError || error instanceof SkillHandoffError) {
            results.push({ ...sanitizeItem(item), applied: false, verified: false, reason: error.message })
          } else {
            throw error
          }
        }
      }
      let committed = state
      if (drafts.length) {
        for (const entry of drafts) {
          try {
            committed = await this.store.recordActivations(root, [entry.draft])
          } catch (error) {
            if (error instanceof SkillHandoffError) {
              entry.result.applied = false
              entry.result.verified = false
              entry.result.reason = error.message
              continue
            }
            throw error
          }
          this.invalidate()
        }
      }
      const after = drafts.some(entry => entry.result.applied) ? await this.#nativeList(root) : native
      for (const result of results) {
        if (!result.applied) continue
        const record = projectBucket(committed, root)?.activations?.[result.dshName]
        result.activationId = record?.id
        const verification = await this.#verifyRecord(record, after.summaries, root)
        result.verified = verification.verified
        if (verification.verified) {
          Object.assign(result, verification.policy, { invocation: verification.invocation })
          result.label = verification.policy.disabled ? labels.disabled : labels.callable
        }
        result.status = result.verified ? 'registered' : 'pending'
        result.reason = result.verified ? 'DSH 已发现该技能。' : '启用记录已保存，等待 DSH 确认。'
      }
      ticket.result = { projectRoot: root, items: results }
      return ticket.result
    })().finally(() => { delete ticket.pending })
    return ticket.pending
  }

  async #applyItem(item, root, state, summaries) {
    if (item.action === 'reuse-active') {
      return {
        draft: null,
        result: { ...sanitizeItem(item), action: 'reuse-active', applied: true, verified: false,
          current: true, reason: '当前项目已经使用相同内容，不会重复安装。' },
      }
    }
    const current = await readSkillPackage(item.sourceFile, {
      content: true, authorization: item.authorization,
    })
    if (current.contentHash !== item.contentHash || current.quickHash !== item.quickHash
      || current.fileCount !== item.fileCount) {
      throw new SkillHandoffError('source-changed', '预览后源技能发生变化，请重新预览。')
    }
    const record = projectBucket(state, root)?.activations?.[item.dshName]
    if (record && record.assetId !== item.assetId && !sameFile(record.sourceFile, item.sourceFile)) {
      throw new SkillHandoffError('name-conflict', '这个项目已经启用了同名但来源不同的技能，未替换原技能。')
    }
    const conflict = await this.#sameNamedNative(item, root, summaries)
    if (conflict) {
      const nativePackage = await this.#nativePackage(conflict, root)
      if (nativePackage?.contentHash !== item.contentHash) {
        throw new SkillHandoffError('name-conflict', 'DSH 已出现同名但内容不同的技能，未覆盖原技能。')
      }
    }

    if (item.action === 'reuse-native' || conflict) {
      const now = this.clock()
      return {
        draft: {
          dshName: item.dshName,
          expectedRevision: item.expectedRevision,
          record: this.#record(item, root, record, {
            mode: 'native', snapshotId: null, previousSnapshotId: record?.snapshotId ?? null,
            contentHash: item.contentHash, quickHash: item.quickHash, now,
          }),
        },
        result: { ...sanitizeItem(item), action: 'reuse-native', applied: true, verified: false,
          current: true, reason: '已登记复用 DSH 原生同名同款技能。' },
      }
    }

    const snapshotId = snapshotIdFor(item.dshName, item.contentHash)
    let snapshot = state.snapshots[snapshotId]
    if (snapshot) {
      const existing = await readSkillPackage(path.join(this.store.snapshotPath(snapshotId), 'SKILL.md'), {
        content: true,
      })
      if (existing.contentHash !== item.contentHash || snapshot.contentHash !== item.contentHash) {
        throw new SkillHandoffError('snapshot-invalid', '已有私有技能快照与记录不一致，未切换。')
      }
    } else {
      await mkdir(this.store.bundlesDir, { recursive: true })
      await mkdir(this.store.stagingDir, { recursive: true })
      const staging = path.join(this.store.stagingDir, randomUUID())
      try {
        const copied = await copySkillPackage(current, staging)
        if (this.validateBundle) await this.validateBundle(staging, root, item.dshName)
        const final = this.store.snapshotPath(snapshotId)
        try {
          await rename(staging, final)
        } catch (error) {
          if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error
          const existing = await readSkillPackage(path.join(final, 'SKILL.md'), { content: true })
          if (existing.contentHash !== item.contentHash) throw error
          await rm(staging, { recursive: true, force: true })
        }
        snapshot = {
          id: snapshotId,
          dshName: item.dshName,
          path: final,
          contentHash: copied.contentHash,
          quickHash: copied.quickHash,
          fileCount: copied.fileCount,
          bytes: copied.bytes,
          createdAt: this.clock(),
        }
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    }
    const now = this.clock()
    return {
      draft: {
        dshName: item.dshName,
        expectedRevision: item.expectedRevision,
        snapshot,
        record: this.#record(item, root, record, {
          mode: 'snapshot', snapshotId, previousSnapshotId: record?.snapshotId ?? null,
          contentHash: item.contentHash, quickHash: item.quickHash, now,
        }),
      },
      result: { ...sanitizeItem(item), action: record ? 'update' : 'enable', applied: true,
        verified: false, current: true, reason: '完整技能包已保存。' },
    }
  }

  #record(item, root, previous, { mode, snapshotId, previousSnapshotId, contentHash, quickHash, now }) {
    return {
      id: previous?.id ?? activationId(root, item.dshName),
      assetId: item.assetId,
      dshName: item.dshName,
      sourceName: item.sourceName,
      sourceFile: item.sourceFile,
      sourceRoot: item.sourceRoot,
      contentHash,
      quickHash,
      mode,
      snapshotId,
      previousSnapshotId,
      activatedAt: previous?.activatedAt ?? now,
      updatedAt: now,
    }
  }

  async #verifyRecord(record, summaries, root) {
    if (!record) return { verified: false, discovered: false }
    const summary = summaries.find(item => item.name === record.dshName)
    if (!summary) return { verified: false, discovered: false }
    const effective = await this.#nativeSkill(summary, root)
    const owned = record.mode === 'native'
      ? summary.provider !== PROVIDER_NAME
      : summary.provider === PROVIDER_NAME && Boolean(summary.path
        && inside(this.store.snapshotPath(record.snapshotId), summary.path))
    const sameContent = effective?.package?.contentHash === record.contentHash
    if (!effective || !effective.invocation || !owned || !sameContent) {
      return { verified: false, discovered: Boolean(summary) }
    }
    return {
      verified: true,
      discovered: true,
      invocation: effective.invocation,
      policy: this.#policy(effective.invocation),
    }
  }

  async deactivate(project, activationIdValue) {
    const root = await findProjectRoot(project.cwd)
    if (!root) throw new SkillHandoffError('project-unavailable', '当前项目目录不可访问。')
    const removed = await this.store.removeActivation(root, activationIdValue)
    const result = {
      dshName: removed.dshName,
      assetId: removed.record.assetId,
      projectRoot: root,
    }
    this.invalidate()
    return result
  }

  async undo(project, activationIdValue) {
    const root = await findProjectRoot(project.cwd)
    if (!root) throw new SkillHandoffError('project-unavailable', '当前项目目录不可访问。')
    const state = await this.store.read()
    const bucket = projectBucket(state, root)
    const entry = Object.entries(bucket?.activations ?? {}).find(([, record]) => record.id === activationIdValue)
    if (!entry) throw new SkillHandoffError('activation-missing', '找不到该项目的技能启用记录。')
    const [name, record] = entry
    if (record.mode !== 'snapshot' || !record.previousSnapshotId) {
      throw new SkillHandoffError('no-previous-version', '没有可回退的上一份技能快照。')
    }
    const previous = state.snapshots[record.previousSnapshotId]
    if (!previous) throw new SkillHandoffError('snapshot-missing', '上一份技能快照记录不存在。')
    const previousPackage = await readSkillPackage(path.join(this.store.snapshotPath(previous.id), 'SKILL.md'), {
      content: true,
    }).catch(error => {
      throw new SkillHandoffError('snapshot-missing', '上一份技能快照不可读取。', { cause: error })
    })
    if (previousPackage.contentHash !== previous.contentHash) {
      throw new SkillHandoffError('snapshot-invalid', '上一份技能快照与记录不一致，未切换。')
    }
    const updated = {
      ...record,
      previousSnapshotId: record.snapshotId,
      snapshotId: previous.id,
      contentHash: previous.contentHash,
      quickHash: previous.quickHash,
      mode: 'snapshot',
      updatedAt: this.clock(),
    }
    await this.store.updateActivation(root, activationIdValue, record, updated)
    const result = { dshName: name, activationId: updated.id, snapshotId: previous.id, projectRoot: root }
    this.invalidate()
    return result
  }

  activeSnapshots(state, root) {
    const bucket = projectBucket(state, root)
    const paths = new Set()
    for (const record of Object.values(bucket?.activations ?? {})) {
      if (record.mode === 'snapshot' && record.snapshotId) {
        paths.add(pathKey(this.store.snapshotPath(record.snapshotId)))
      }
    }
    return paths
  }
}
