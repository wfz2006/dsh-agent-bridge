import { lstat, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

const applicationId = 0x44534841
const filename = 'agent-bridge-archive.sqlite'

export class ProjectArchiveError extends Error {}

function databasePath(config) {
  const file = config.configFile
  return typeof file === 'string' && isAbsolute(file) ? join(dirname(file), filename) : undefined
}

async function archiveExists(file) {
  if (!file) return false
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.nlink > 1) {
      throw new ProjectArchiveError(`${filename} 应为独立的常规文件。`)
    }
    return true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return false
  }
}

async function withArchive(file, readOnly, operation) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly })
  try {
    db.exec('PRAGMA busy_timeout = 2000; PRAGMA trusted_schema = OFF')
    db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE')
    try {
      const result = operation(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* SQLite may already have rolled back the failed transaction. */ }
      throw error
    }
  } finally {
    db.close()
  }
}

function initialized(db) {
  const id = db.prepare('PRAGMA application_id').get().application_id
  if (id === applicationId) return true
  if (id === 0 && !db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) return false
  throw new ProjectArchiveError(`${filename} 不是 Agent 接续的项目归档数据库。`)
}

async function readArchive(config, operation) {
  const file = databasePath(config)
  if (!await archiveExists(file)) return undefined
  return withArchive(file, true, db => initialized(db) ? operation(db) : undefined)
}

async function writeArchive(config, create, operation) {
  const file = databasePath(config)
  if (!file) throw new ProjectArchiveError('找不到插件配置文件对应的存储目录。')
  if (!await archiveExists(file)) {
    if (!create) return undefined
    await mkdir(dirname(file), { recursive: true })
  }
  return withArchive(file, false, db => {
    if (!initialized(db)) {
      if (!create) return undefined
      db.exec(`PRAGMA application_id = ${applicationId}; CREATE TABLE archived_projects (project_id TEXT PRIMARY KEY) STRICT`)
    }
    return operation(db)
  })
}

function hasPreferences(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'project_preferences'").get())
}

function ensurePreferences(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_preferences (
    project_id TEXT PRIMARY KEY,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    continued_at INTEGER CHECK (continued_at > 0),
    selection_json TEXT
  ) STRICT`)
}

export async function readProjectState(config) {
  return await readArchive(config, db => {
    const archivedIds = new Set(db.prepare('SELECT project_id FROM archived_projects').all().map(row => row.project_id))
    const rows = hasPreferences(db) ? db.prepare(
      'SELECT project_id, pinned, continued_at FROM project_preferences WHERE pinned = 1 OR continued_at IS NOT NULL',
    ).all() : []
    const preferences = new Map(rows.map(row => [row.project_id, { pinned: row.pinned === 1, continuedAt: row.continued_at }]))
    return { archivedIds, preferences }
  }) ?? { archivedIds: new Set(), preferences: new Map() }
}

export async function writeProjectArchive(config, projectIds, archived) {
  return await writeArchive(config, archived, db => {
    const update = db.prepare(archived
      ? 'INSERT INTO archived_projects (project_id) VALUES (?) ON CONFLICT (project_id) DO NOTHING'
      : 'DELETE FROM archived_projects WHERE project_id = ?')
    return projectIds.filter(projectId => update.run(projectId).changes > 0)
  }) ?? []
}

export async function writeProjectPin(config, projectId, pinned) {
  await writeArchive(config, pinned, db => {
    if (!pinned) {
      if (hasPreferences(db)) db.prepare('UPDATE project_preferences SET pinned = 0 WHERE project_id = ? AND pinned = 1').run(projectId)
      return
    }
    ensurePreferences(db)
    db.prepare(`INSERT INTO project_preferences (project_id, pinned) VALUES (?, 1)
      ON CONFLICT (project_id) DO UPDATE SET pinned = excluded.pinned
      WHERE project_preferences.pinned <> excluded.pinned`).run(projectId)
  })
}

export async function readProjectSelection(config, projectId) {
  const saved = await readArchive(config, db => hasPreferences(db)
    ? db.prepare('SELECT selection_json FROM project_preferences WHERE project_id = ?').get(projectId)?.selection_json
    : undefined)
  return saved == null ? null : JSON.parse(saved)
}

export async function writeProjectSelection(config, projectId, selection) {
  await writeArchive(config, true, db => {
    ensurePreferences(db)
    db.prepare(`INSERT INTO project_preferences (project_id, selection_json) VALUES (?, ?)
      ON CONFLICT (project_id) DO UPDATE SET selection_json = excluded.selection_json
      WHERE project_preferences.selection_json IS NOT excluded.selection_json`).run(projectId, JSON.stringify(selection))
  })
}

export async function writeProjectContinuation(config, projectId) {
  return writeArchive(config, true, db => {
    ensurePreferences(db)
    return db.prepare(`INSERT INTO project_preferences (project_id, continued_at) VALUES (?, ?)
      ON CONFLICT (project_id) DO UPDATE SET continued_at = MAX(COALESCE(project_preferences.continued_at, 0), excluded.continued_at)
      RETURNING continued_at`).get(projectId, Date.now()).continued_at
  })
}

export async function readCodexAliases(config) {
  const projects = new Map()
  await readArchive(config, db => {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='codex_source_aliases'").get()) return
    for (const { project_id, source_id, alias } of db.prepare('SELECT project_id,source_id,alias FROM codex_source_aliases WHERE source_id IS NOT NULL').iterate()) {
      if (!projects.has(project_id)) projects.set(project_id, new Map())
      const sources = projects.get(project_id)
      if (!sources.has(source_id)) sources.set(source_id, [])
      sources.get(source_id).push(alias)
    }
  })
  return projects
}

export async function saveCodexAliases(config, projectId, links) {
  await writeArchive(config, true, db => {
    db.exec(`CREATE TABLE IF NOT EXISTS codex_source_aliases (
      project_id TEXT NOT NULL, alias TEXT NOT NULL, source_id TEXT, PRIMARY KEY (project_id,alias)
    ) STRICT`)
    const insert = db.prepare(`INSERT INTO codex_source_aliases VALUES (?,?,?) ON CONFLICT(project_id,alias)
      DO UPDATE SET source_id=NULL WHERE source_id<>excluded.source_id`)
    for (const [source, alias] of links) insert.run(projectId, alias, source.id)
  })
}

export async function readProjectRelay(config, projectId) {
  return await readArchive(config, db => {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='project_relay' AND type='table'").get()) return []
    return db.prepare('SELECT item FROM project_relay WHERE project_id=? ORDER BY rowid')
      .all(projectId).map(row => JSON.parse(row.item))
  }) ?? []
}

export async function changeProjectRelay(config, projectId, id, change, previousIds = []) {
  return writeArchive(config, true, db => {
    db.exec(`CREATE TABLE IF NOT EXISTS project_relay (
      project_id TEXT NOT NULL, id TEXT NOT NULL, item TEXT NOT NULL, PRIMARY KEY (project_id,id)
    ) STRICT`)
    const row = db.prepare(`SELECT id,item FROM project_relay WHERE project_id=? AND id IN (SELECT value FROM json_each(?))
      ORDER BY (id=?) DESC,rowid LIMIT 1`).get(projectId, JSON.stringify([id, ...previousIds]), id)
    const storedId = row?.id ?? id
    const item = change(row && JSON.parse(row.item))
    if (item) {
      db.prepare(`INSERT INTO project_relay VALUES (?,?,?) ON CONFLICT(project_id,id)
        DO UPDATE SET item=excluded.item`).run(projectId, storedId, JSON.stringify(item))
    } else db.prepare('DELETE FROM project_relay WHERE project_id=? AND id=?').run(projectId, storedId)
    return item ?? null
  })
}
