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

export async function readArchivedProjects(config) {
  const file = databasePath(config)
  if (!await archiveExists(file)) return new Set()
  return withArchive(file, true, db => {
    if (!initialized(db)) return new Set()
    return new Set(db.prepare('SELECT project_id FROM archived_projects').all().map(row => row.project_id))
  })
}

export async function writeProjectArchive(config, projectIds, archived) {
  const file = databasePath(config)
  if (!file) throw new ProjectArchiveError('找不到插件配置文件对应的存储目录。')
  if (!await archiveExists(file)) {
    if (!archived) return []
    await mkdir(dirname(file), { recursive: true })
  }
  return withArchive(file, false, db => {
    if (!initialized(db)) {
      if (!archived) return []
      db.exec(`PRAGMA application_id = ${applicationId}; CREATE TABLE archived_projects (project_id TEXT PRIMARY KEY) STRICT`)
    }
    const update = db.prepare(archived
      ? 'INSERT INTO archived_projects (project_id) VALUES (?) ON CONFLICT (project_id) DO NOTHING'
      : 'DELETE FROM archived_projects WHERE project_id = ?')
    return projectIds.filter(projectId => update.run(projectId).changes > 0)
  })
}
