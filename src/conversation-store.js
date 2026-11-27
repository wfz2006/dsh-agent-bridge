import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { keyFor } from './handoff.js'
import { isSessionId, traceDirectory } from './session-trace.js'

const pageBytes = 64 * 1024
const partLength = 8_000
const maxAttachmentBytes = 32 * 1024 * 1024
const lifetime = 10 * 60_000

function historyDirectory(config) {
  return path.join(path.dirname(traceDirectory(config)), 'agent-bridge-history')
}

async function database(config, create = true) {
  const directory = historyDirectory(config)
  const file = path.join(directory, 'history.sqlite')
  if (create) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const handle = await open(file, 'a', 0o600)
    await handle.close()
  } else if (!existsSync(file)) return
  const db = new DatabaseSync(file, { readOnly: !create })
  try {
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 2000;')
    if (!create) return db
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL,
        state TEXT NOT NULL, created INTEGER NOT NULL,
        project_id TEXT, source_id TEXT, target TEXT,
        record TEXT, seed TEXT
      );
      CREATE INDEX IF NOT EXISTS snapshot_source ON snapshots(project_id, source_id, state);
      CREATE TABLE IF NOT EXISTS entries (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, part INTEGER NOT NULL,
        turn INTEGER, call_id TEXT, kind TEXT NOT NULL, item TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, seq, part)
      );
      CREATE INDEX IF NOT EXISTS entry_call ON entries(snapshot_id, call_id, kind, seq);
      CREATE INDEX IF NOT EXISTS entry_turn ON entries(snapshot_id, turn, seq, part);
      CREATE INDEX IF NOT EXISTS entry_display ON entries(snapshot_id, COALESCE(turn, 0), seq, part);
      CREATE TABLE IF NOT EXISTS attachments (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        hash TEXT NOT NULL, type TEXT NOT NULL, bytes BLOB NOT NULL,
        PRIMARY KEY (snapshot_id, hash)
      );
    `)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

async function use(config, action, write = true) {
  const db = await database(config, write)
  if (!db) return
  try { return action(db) } finally { db.close() }
}

function* parts(text) {
  let offset = 0
  do {
    let end = Math.min(offset + partLength, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--
    yield { text: text.slice(offset, end), offset, continued: end < text.length }
    offset = end
  } while (offset < text.length)
}

export function imageMediaType(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'image/gif'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
}

function saveAttachment(db, id, item, data) {
  if (!Buffer.isBuffer(data)) return { ...item, status: item.status ?? 'attachment-unavailable' }
  if (data.length > maxAttachmentBytes) return { ...item, status: 'attachment-too-large' }
  const attachmentId = createHash('sha256').update(data).digest('hex')
  const mediaType = imageMediaType(data) ?? 'application/octet-stream'
  db.prepare('INSERT OR IGNORE INTO attachments VALUES (?, ?, ?, ?)').run(id, attachmentId, mediaType, data)
  return { ...item, status: 'saved', attachmentId, mediaType, bytes: data.length }
}

function appendProjection(messages, message, state) {
  const text = message.text.slice(0, 24_000).replace(/[\uD800-\uDBFF]$/, '')
  if (text.length < message.text.length) state.truncated = true
  messages.push({ ...message, text })
  state.characters += text.length
  while (messages.length > 600 || state.characters > 160_000) {
    const removed = messages.shift()
    state.characters -= removed.text.length
    if (removed.role === 'user') state.lastQuestion = removed
    state.truncated = true
  }
}

function disambiguateToolCalls(db, id, trace) {
  const duplicates = db.prepare(`SELECT call_id FROM entries
    WHERE snapshot_id=? AND call_id IS NOT NULL AND kind='tool_call' AND part=0
    GROUP BY call_id HAVING count(*)>1`).all(id)
  if (!duplicates.length) return
  const read = db.prepare(`SELECT kind,seq,turn FROM entries
    WHERE snapshot_id=? AND call_id=? AND part=0 ORDER BY seq`)
  const update = db.prepare('UPDATE entries SET call_id=? WHERE snapshot_id=? AND seq=?')
  const traceBySeq = new Map(trace.map(item => [item.seq, item]))
  for (const { call_id: key } of duplicates) {
    const entries = read.all(id, key)
    const callsAndResults = entries.filter(item => item.kind === 'tool_call' || item.kind === 'tool_result')
    // Pair a reused id only when each occurrence settled before the next call.
    // Overlapping calls and extra or missing results keep their unknown owner.
    if (callsAndResults.length % 2 || !callsAndResults.every((item, index) =>
      item.kind === (index % 2 ? 'tool_result' : 'tool_call') && (index % 2 || item.turn !== null))) continue
    let occurrence
    for (const item of entries) {
      if (item.kind === 'tool_call') occurrence = `${key}:${item.seq}`
      if (!occurrence) continue
      update.run(occurrence, id, item.seq)
      const stamp = traceBySeq.get(item.seq)
      if (stamp) stamp.callKey = occurrence
    }
  }
}

export async function stageConversation(config, metadata, events, redact, loadAttachment) {
  const { id, sessionId } = metadata
  const db = await database(config)
  const messages = []
  const trace = []
  const usedSkills = new Set()
  const stats = { userMessages: 0, assistantMessages: 0 }
  const state = { characters: 0, truncated: false }
  const history = { snapshotId: id, messages: 0, tools: 0, attachments: 0, gaps: 0, complete: true, nativeMessages: 0 }
  let seq = 0
  let timed = 0
  let firstAt = Infinity
  let lastAt = 0
  let created = false
  try {
    db.prepare("DELETE FROM snapshots WHERE state IN ('loading','preview') AND created < ?").run(Date.now() - lifetime)
    db.prepare("INSERT INTO snapshots(id,session_id,state,created,project_id,source_id,target) VALUES (?,?,'loading',?,?,?,?)")
      .run(id, sessionId, Date.now(), metadata.projectId ?? null, metadata.sourceId ?? null, metadata.targetCwd ?? null)
    created = true
    const insert = db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?)')
    const batch = []
    let batchBytes = 0
    const flush = () => {
      if (!batch.length) return
      db.exec('BEGIN')
      try {
        for (const row of batch) insert.run(id, ...row)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      batch.length = 0
      batchBytes = 0
    }
    const put = (item, callKey) => {
      seq++
      const chunks = 'text' in item ? parts(item.text) : [{ offset: 0 }]
      for (const chunk of chunks) {
        const json = JSON.stringify({ ...item, ...chunk, seq })
        batch.push([seq, chunk.offset, item.turn ?? null, callKey ?? null, item.kind, json])
        batchBytes += Buffer.byteLength(json)
        if (batch.length >= 128 || batchBytes >= 512 * 1024) flush()
      }
    }
    const endings = new Map()
    for await (const raw of events) {
      if (raw.kind === 'metadata') {
        for (const skill of raw.usedSkills ?? []) usedSkills.add(skill)
        if (raw.sourceStats?.tokens) stats.tokens = raw.sourceStats.tokens
        continue
      }
      const item = { kind: raw.kind }
      let callKey
      if (Number.isSafeInteger(raw.turn) && raw.turn > 0) item.turn = raw.turn
      if (Number.isFinite(raw.time) && raw.time > 0) item.time = raw.time
      if (typeof raw.sourceId === 'string') item.sourceId = redact(raw.sourceId)
      if (typeof raw.parentId === 'string') item.parentId = redact(raw.parentId)
      if (typeof raw.branchId === 'string') item.branchId = redact(raw.branchId)
      if (typeof raw.text === 'string') item.text = redact(raw.text)
      if (typeof raw.callId === 'string' && raw.callId) {
        item.callId = redact(raw.callId)
        callKey = createHash('sha256').update(JSON.stringify([raw.branchId ?? '', raw.callId])).digest('hex')
      }
      if (raw.kind === 'message') {
        if (!['user', 'assistant'].includes(raw.role) || !item.text?.trim()) continue
        item.role = raw.role
        history.messages++
        stats[`${item.role}Messages`]++
        if (item.time && raw.estimatedTime !== true) {
          timed++
          firstAt = Math.min(firstAt, item.time)
          lastAt = Math.max(lastAt, item.time)
        }
        if (!item.branchId) appendProjection(messages, { role: item.role, text: item.text, time: item.time, turn: item.turn, sourceSeq: seq + 1 }, state)
      } else if (raw.kind === 'gap') {
        item.reason = redact(raw.reason)
        history.gaps++
      } else if (raw.kind === 'attachment') {
        item.name = redact(raw.name ?? '附件').slice(0, 240)
        if (['user', 'assistant'].includes(raw.role)) item.role = raw.role
        if (raw.status) item.status = raw.status
        const attachment = await loadAttachment?.(raw)
        Object.assign(item, saveAttachment(db, id, { ...item, ...attachment?.details }, attachment?.bytes ?? raw.data))
        history.attachments++
        if (item.status !== 'saved') history.gaps++
        if (raw.role === 'user' && raw.standalone === true && !item.branchId) {
          item.standalone = true
          appendProjection(messages, { role: 'user', text: `[来源附件 ${item.name}，见完整历史]`, time: item.time, turn: item.turn, sourceSeq: seq + 1 }, state)
        }
      } else if (raw.kind === 'turn_end' && item.turn && ['completed', 'interrupted'].includes(raw.status)) {
        item.status = raw.status
        if (!item.branchId) endings.set(item.turn, raw.status)
      } else if (['summary', 'tool_call', 'tool_result'].includes(raw.kind)) {
        if (raw.name) item.name = redact(raw.name)
        if (raw.status) item.status = raw.status
        if (raw.kind === 'tool_call') history.tools++
        trace.push({ ...item, callKey, seq: seq + 1, id: `source-${seq + 1}`, text: (item.text ?? '').slice(0, 8193) })
        if (trace.length > 600) trace.shift()
      } else continue
      put(item, callKey)
    }
    flush()
    disambiguateToolCalls(db, id, trace)
    db.prepare(`UPDATE entries AS result SET turn = (
        SELECT CASE WHEN COUNT(*)=1 THEN MIN(call.turn) END FROM entries AS call
        WHERE call.snapshot_id=result.snapshot_id AND call.call_id=result.call_id AND call.kind='tool_call' AND call.part=0
      ) WHERE result.snapshot_id=? AND (result.kind='tool_result' OR (result.kind='attachment' AND result.call_id IS NOT NULL))`).run(id)
    const unmatched = db.prepare(`SELECT count(*) AS count FROM entries WHERE snapshot_id=? AND part=0 AND turn IS NULL
      AND (kind='tool_result' OR (kind='attachment' AND call_id IS NOT NULL))`).get(id).count
    if (unmatched) {
      history.gaps += unmatched
      put({ kind: 'gap', reason: `${unmatched} 条工具结果或附件的归属未知，原文见来源记录。` })
      flush()
    }
    if (messages[0]?.role === 'assistant' && state.lastQuestion) {
      while (messages.length >= 600 || state.characters + state.lastQuestion.text.length > 160_000) {
        state.characters -= messages.shift().text.length
      }
      messages.unshift(state.lastQuestion)
    }
    const retained = messages.slice(messages.findIndex(message => message.role === 'user') < 0
      ? messages.length : messages.findIndex(message => message.role === 'user'))
    for (const message of retained) {
      if (message.role === 'user' && endings.has(message.turn)) message.endReason = endings.get(message.turn)
    }
    history.nativeMessages = retained.length
    if (retained[0]?.turn) history.nativeFirstTurn = retained[0].turn
    if (retained.at(-1)?.turn) history.nativeLastTurn = retained.at(-1).turn
    history.complete = history.gaps === 0
    const anchors = new Map(retained.map((message, index) => [message.turn, index]))
    const findCall = db.prepare("SELECT turn,item,COUNT(*) AS count FROM entries WHERE snapshot_id=? AND call_id=? AND kind='tool_call' AND part=0")
    const findResult = db.prepare("SELECT item FROM entries WHERE snapshot_id=? AND call_id=? AND kind='tool_result' ORDER BY seq LIMIT 1")
    const pairedTrace = trace.flatMap(item => {
      if (item.kind === 'tool_result') {
        const call = item.callKey && findCall.get(id, item.callKey)
        if (call?.count !== 1) return []
        item.turn = call.turn
        item.name ??= JSON.parse(call.item).name
      }
      if (item.kind === 'tool_call') {
        const result = item.callKey && findCall.get(id, item.callKey).count === 1 && findResult.get(id, item.callKey)
        item.status = result ? JSON.parse(result.item).status ?? 'ok' : 'missing'
      }
      const messageIndex = anchors.get(item.turn)
      const { callKey, seq, ...reviewed } = item
      return messageIndex === undefined ? [] : [{ ...reviewed, messageIndex }]
    }).sort((a, b) => a.turn - b.turn)
    const sourceStats = { ...stats, importedMessages: retained.length, partial: !history.complete,
      ...(timed >= 2 && timed === history.messages ? { elapsedMs: lastAt - firstAt } : {}) }
    const record = { ...metadata, history, sourceStats, messages: retained, trace: pairedTrace,
      usedSkills: [...usedSkills], truncated: state.truncated || !history.complete }
    db.prepare("UPDATE snapshots SET state='preview', created=?, record=? WHERE id=?")
      .run(Date.now(), JSON.stringify(record), id)
    return record
  } catch (error) {
    if (created) db.prepare("DELETE FROM snapshots WHERE id=? AND state='loading'").run(id)
    throw error
  } finally {
    db.close()
  }
}

function readRecord(row) {
  return row?.record ? { ...JSON.parse(row.record), state: row.state, seed: row.seed ? JSON.parse(row.seed) : undefined } : undefined
}

export async function readConversationSnapshot(config, id) {
  if (!isSessionId(id)) return
  return use(config, db => readRecord(db.prepare("SELECT record,state,seed FROM snapshots WHERE id=? AND (state IN ('approved','done') OR (state='preview' AND created>=?))")
    .get(id, Date.now() - lifetime)), false)
}

export async function readPendingConversation(config, projectId, sourceIds, target) {
  return use(config, db => {
    // Older versions allowed pending copies at multiple targets. The caller must
    // identify one of those targets before a particular receipt can be resumed.
    const rows = db.prepare(`SELECT record,state,seed FROM snapshots WHERE project_id=?
      AND source_id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR target=?) AND state='approved' LIMIT 2`)
      .all(projectId, JSON.stringify(Array.isArray(sourceIds) ? sourceIds : [sourceIds]), target ?? null, target ?? null)
    return rows.length === 1 ? readRecord(rows[0]) : undefined
  }, false)
}

// Separate SQLite lock files let unrelated imports run concurrently. The OS releases each
// lock on process exit, including a crash partway through a DSH write. Only a successful
// callback may retire the ticket (completed, or replaced with a freshly reviewed target).
export async function withApprovedImportLock(config, id, action) {
  if (!isSessionId(id)) throw new Error('Invalid import receipt')
  const file = path.join(historyDirectory(config), id + '.lock')
  const lock = new DatabaseSync(file)
  let retired = false
  try {
    try { lock.exec('BEGIN EXCLUSIVE') } catch (error) {
      if (error.errcode !== 5) throw error
      throw Object.assign(new Error('这条会话正在迁入，请等待当前操作结束。'), { status: 409 })
    }
    const result = await action()
    retired = true
    return result
  } finally {
    lock.close()
    if (retired) await unlink(file).catch(() => {})
  }
}

export async function setConversationAttempt(config, id, attempt) {
  return use(config, db => db.prepare(`UPDATE snapshots SET record=json_set(record,'$.importAttempt',?)
    WHERE id=? AND state='approved' AND (?!='unwritten' OR seed IS NULL)`).run(attempt, id, attempt).changes)
}

export async function rebindConversation(config, previous, metadata, { approvedAttempt } = {}) {
  const record = { ...previous, ...metadata,
    history: { ...previous.history, snapshotId: metadata.id } }
  delete record.state
  delete record.seed
  if (approvedAttempt) {
    // Keep the reviewed archive and excerpt text durable through a close/reload. A new
    // ticket binds the new target and requires a separate user request to write to DSH.
    record.importAttempt = 'review'
    if (record.continuation) {
      const { firstMessage } = record.continuation
      const items = record.continuation.items.map(item => item.snapshotId === previous.id ? { ...item, snapshotId: record.id } : item)
      const refs = items.map(({ snapshotId, seq, offset }) => ({ snapshotId, seq, offset }))
      record.continuation = { firstMessage, items, contextKey: keyFor(record.id, refs, firstMessage) }
    }
  }
  return use(config, db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const valid = approvedAttempt
        ? db.prepare(`SELECT 1 FROM snapshots WHERE id=? AND state='approved' AND seed IS NULL AND json_extract(record,'$.importAttempt')=?
          AND json_extract(record,'$.importAttempt') IN ('unwritten','review') AND NOT EXISTS (
            SELECT 1 FROM snapshots AS other WHERE other.project_id=? AND other.id!=? AND other.state='approved'
              AND other.source_id IN (SELECT value FROM json_each(?)))`)
          .get(previous.id, approvedAttempt, record.projectId, previous.id, JSON.stringify(record.sourceIds ?? [record.sourceId]))
        : db.prepare("SELECT 1 FROM snapshots WHERE id=? AND state='preview' AND created>=?").get(previous.id, Date.now() - lifetime)
      if (!valid) {
        db.exec('ROLLBACK')
        return undefined
      }
      const state = approvedAttempt ? 'approved' : 'preview'
      db.prepare('INSERT INTO snapshots(id,session_id,state,created,project_id,source_id,target,record) VALUES (?,?,?,?,?,?,?,?)')
        .run(record.id, record.sessionId, state, Date.now(), record.projectId, record.sourceId, record.targetCwd, JSON.stringify(record))
      db.prepare('INSERT INTO entries SELECT ?,seq,part,turn,call_id,kind,item FROM entries WHERE snapshot_id=?')
        .run(record.id, previous.id)
      db.prepare('INSERT INTO attachments SELECT ?,hash,type,bytes FROM attachments WHERE snapshot_id=?')
        .run(record.id, previous.id)
      db.prepare('DELETE FROM snapshots WHERE id=?').run(previous.id)
      db.exec('COMMIT')
      return { ...record, state }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
}

export async function readStoredConversation(config, sessionId) {
  if (!isSessionId(sessionId)) return
  return use(config, db => readRecord(db.prepare("SELECT record,state FROM snapshots WHERE session_id=? AND state='done'").get(sessionId)), false)
}

export async function readCompletedConversationImports(config, projectId, sourceIds) {
  if (!sourceIds.length) return []
  const rows = await use(config, db => db.prepare(`
    SELECT source_id AS sourceId, session_id AS sessionId, created AS importedAt,
      json_type(record,'$.importedAt') IS NULL AS approximate
    FROM snapshots WHERE project_id=? AND state='done'
      AND source_id IN (SELECT value FROM json_each(?))
    ORDER BY created DESC, rowid DESC
  `).all(projectId, JSON.stringify(sourceIds)), false)
  return rows ?? []
}

export async function approveConversation(config, id, continuation = null, { unavailableImports, sourceIds = [] } = {}) {
  return use(config, db => db.prepare(`UPDATE snapshots AS proposed SET state='approved',
    record=json_set(record,'$.continuation',json($continuation),'$.importAttempt','ready')
    WHERE proposed.id=$id AND proposed.state='preview' AND proposed.created >= $cutoff AND NOT EXISTS (
      SELECT 1 FROM snapshots AS active WHERE active.project_id=proposed.project_id
        AND (active.source_id=proposed.source_id OR active.source_id IN (SELECT value FROM json_each($aliases)))
        AND active.state='approved'
    ) AND (
      $unavailable IS NULL OR NOT EXISTS (
        SELECT 1 FROM snapshots AS completed
        WHERE completed.project_id=proposed.project_id AND completed.state='done'
          AND (completed.source_id=proposed.source_id OR completed.source_id IN (SELECT value FROM json_each($aliases)))
          AND completed.session_id NOT IN (SELECT value FROM json_each($unavailable))
      )
    )`)
    .run({ $continuation: JSON.stringify(continuation), $id: id, $cutoff: Date.now() - lifetime, $aliases: JSON.stringify(sourceIds),
      $unavailable: unavailableImports ? JSON.stringify(unavailableImports) : null }).changes)
}

export async function saveConversationSeed(config, id, seed) {
  return use(config, db => {
    db.prepare("UPDATE snapshots SET seed=? WHERE id=? AND state='approved' AND seed IS NULL").run(JSON.stringify(seed), id)
    const row = db.prepare("SELECT seed FROM snapshots WHERE id=? AND state='approved'").get(id)
    if (!row?.seed) throw new Error('Import receipt was not found')
    return JSON.parse(row.seed)
  })
}

export async function finishConversation(config, id, nativeTimeline) {
  return use(config, db => {
    // Older completed snapshots keep their preview timestamp in created.
    const importedAt = Date.now()
    if (!nativeTimeline) return db.prepare(`UPDATE snapshots SET state='done', seed=NULL,
      created=$importedAt, record=json_set(record,'$.importedAt',$importedAt)
      WHERE id=$id AND state='approved'`).run({ $id: id, $importedAt: importedAt })
    return db.prepare(`UPDATE snapshots SET state='done', seed=NULL, created=$importedAt, record=json_set(record,
        '$.importedAt', $importedAt, '$.history', json_patch(json_extract(record,'$.history'), json($timeline)),
        '$.sourceStats.importedMessages', $messageCount)
      WHERE id=$id AND state='approved'`).run({ $id: id, $importedAt: importedAt,
      $timeline: JSON.stringify({ ...nativeTimeline, nativeTimeline: true }), $messageCount: nativeTimeline.nativeMessages })
  })
}

export async function discardConversation(config, id) {
  if (isSessionId(id)) await use(config, db => db.prepare("DELETE FROM snapshots WHERE id=? AND state='preview'").run(id))
}

export async function locateHistoryMessage(config, id, { turn, hash, offset }) {
  return use(config, db => {
    const rows = db.prepare(`SELECT seq,part,item FROM entries
      WHERE snapshot_id=? AND turn=? AND kind='message' ORDER BY seq,part`).iterate(id, turn)
    let seq
    let part
    let texts = []
    const locate = () => {
      if (!texts.length || keyFor(texts.join('')) !== hash || part === undefined) return
      const before = part === 0 ? `${seq - 1}:999999999999999` : `${seq}:${part - 1}`
      return { turn, cursor: `${id}:${turn}:${before}`, seq, offset: part }
    }
    for (const row of rows) {
      if (row.seq !== seq) {
        const found = locate()
        if (found) return found
        seq = row.seq
        texts = []
        part = undefined
      }
      const { text } = JSON.parse(row.item)
      texts.push(text)
      if (row.part <= offset && offset < row.part + text.length) part = row.part
    }
    return locate()
  }, false)
}

export async function readContextExcerpts(config, projectId, excerpts) {
  return use(config, db => {
    const select = db.prepare(`SELECT e.turn,e.item,s.source_id AS sourceId,json_extract(s.record,'$.title') AS title
      FROM entries e JOIN snapshots s ON s.id=e.snapshot_id
      WHERE s.project_id=? AND s.id=? AND e.seq=? AND e.part=?
        AND (s.state IN ('approved','done') OR (s.state='preview' AND s.created>=?))
        AND e.kind IN ('message','tool_result','tool_call','summary')`)
    return excerpts.map(excerpt => {
      const row = select.get(projectId, excerpt.snapshotId, excerpt.seq, excerpt.offset, Date.now() - lifetime)
      if (!row) return null
      const item = JSON.parse(row.item)
      if (!item.text?.trim()) return null
      return { ...excerpt, sourceId: row.sourceId, title: row.title, turn: row.turn, kind: item.kind, role: item.role, text: item.text }
    })
  }, false)
}

export async function readRetainedRelaySnapshot(config, projectId, source) {
  return use(config, db => {
    const candidates = db.prepare(`SELECT s.id,e.item FROM snapshots s JOIN entries e ON e.snapshot_id=s.id
      WHERE s.project_id=? AND s.source_id=? AND e.turn=? AND e.kind=? AND e.seq=? AND e.part=?
        AND (s.state IN ('approved','done') OR (s.state='preview' AND s.created>=?))
      ORDER BY s.created DESC,s.rowid DESC`).iterate(projectId, source.id, source.turn, source.kind, source.seq, source.offset, Date.now() - lifetime)
    for (const row of candidates) {
      if (keyFor(JSON.parse(row.item).text) === source.hash) {
        return readRecord(db.prepare('SELECT record,state FROM snapshots WHERE id=?').get(row.id))
      }
    }
  }, false)
}

export async function locateRelayExcerpt(config, id, { turn, kind, seq, offset, hash }) {
  return use(config, db => {
    const rows = db.prepare(`SELECT seq,part,item FROM entries WHERE snapshot_id=? AND turn=? AND kind=?
      ORDER BY (seq=?) DESC,(part=?) DESC,seq,part`).iterate(id, turn, kind, seq, offset)
    for (const row of rows) {
      if (keyFor(JSON.parse(row.item).text) !== hash) continue
      const before = row.part ? `${row.seq}:${row.part - 1}` : `${row.seq - 1}:999999999999999`
      return { turn, cursor: `${id}:${turn}:${before}`, seq: row.seq, offset: row.part }
    }
    if (db.prepare('SELECT 1 FROM entries WHERE snapshot_id=? AND turn=? LIMIT 1').get(id, turn)) {
      return { turn, changed: true }
    }
  }, false)
}

export function firstContinuationMessage(record) {
  return record.continuation?.firstMessage ?? record.messages[0]?.text
}

function cursorPosition(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return [0, 0, 0]
  const values = typeof cursor === 'string' && /^\d{1,15}:\d{1,15}:\d{1,15}$/.test(cursor) ? cursor.split(':').map(Number) : undefined
  if (!values) throw Object.assign(new Error('历史页位置无效。'), { status: 400 })
  return values
}

const processKinds = "kind IN ('summary','tool_call','tool_result')"

function projectedPositions(db, record) {
  if (record.messages.every(message => Number.isSafeInteger(message.sourceSeq))) {
    return record.messages.map(message => message.sourceSeq)
  }
  // Earlier packages did not persist the positions. The projection retains
  // the newest matching messages, including the user prompt restored at its head.
  const rows = db.prepare(`
    SELECT seq,kind,item FROM entries WHERE snapshot_id=? AND part=0
      AND kind IN ('message','attachment') ORDER BY seq DESC
  `).iterate(record.id)
  const rest = db.prepare('SELECT item FROM entries WHERE snapshot_id=? AND seq=? AND part>0 AND part<24000 ORDER BY part')
  const positions = []
  let index = record.messages.length - 1
  for (const row of rows) {
    const message = record.messages[index]
    const item = JSON.parse(row.item)
    if (item.branchId || item.role !== message.role || item.turn !== message.turn || item.time !== message.time) continue
    const text = row.kind === 'attachment' ? `[来源附件 ${item.name}，见完整历史]` : item.text
    if (!message.text.startsWith(text.slice(0, message.text.length))) continue
    const source = row.kind === 'message' && item.continued
      ? text + rest.all(record.id, row.seq).map(value => JSON.parse(value.item).text).join('')
      : text
    if (source.slice(0, 24000).replace(/[\uD800-\uDBFF]$/, '') !== message.text) continue
    positions[index--] = row.seq
    if (index < 0) return positions
  }
  return []
}

export async function* readNativeTurns(config, record) {
  const db = await database(config, false)
  if (!db) return
  try {
    const positions = projectedPositions(db, record)
    const context = new Map(positions.map((seq, index) => [
      seq, index === 0 ? firstContinuationMessage(record) : record.messages[index].text,
    ]))
    const initialTime = db.prepare(`
      SELECT json_extract(item,'$.time') AS time FROM entries
      WHERE snapshot_id=? AND part=0 AND turn IS NOT NULL AND kind IN ('message','attachment')
        AND json_extract(item,'$.branchId') IS NULL AND json_extract(item,'$.time') IS NOT NULL
      ORDER BY seq LIMIT 1
    `).get(record.id)?.time
    const rows = db.prepare(`
      SELECT seq,turn,call_id,item FROM entries
      WHERE snapshot_id=? AND turn IS NOT NULL AND kind != 'gap'
        AND json_extract(item,'$.branchId') IS NULL
      ORDER BY turn,seq,part
    `).iterate(record.id)
    let turn
    let entries = []
    let current
    let text = []
    const finish = () => {
      if (!current) return
      if (text.length > 1) current.text = text.join('')
      entries.push(current)
    }
    for (const row of rows) {
      const item = JSON.parse(row.item)
      if (current?.seq === row.seq) {
        text.push(item.text)
        continue
      }
      finish()
      if (turn !== undefined && row.turn !== turn) {
        yield { entries, initialTime }
        entries = []
      }
      turn = row.turn
      current = { ...item, turn, callKey: row.call_id, contextText: context.get(row.seq) }
      text = [item.text]
    }
    finish()
    if (entries.length) yield { entries, initialTime }
  } finally {
    db.close()
  }
}

export async function readProcessPlacements(config, record, events) {
  return use(config, db => {
    const positions = projectedPositions(db, record)
    if (positions.length !== record.messages.length) return []
    const totals = db.prepare(`
      SELECT count(*) AS count, count(*) FILTER (WHERE kind='tool_call') AS calls
      FROM entries WHERE snapshot_id=? AND turn=? AND seq>? AND seq<? AND part=0
        AND ${processKinds} AND json_extract(item,'$.branchId') IS NULL
    `)
    const placements = []
    let messageIndex = 0
    let sourceTurn
    let after
    let start
    for (const event of events) {
      if (event.type === 'turn/start') start = event.seq
      if (event.type === 'user/message') {
        sourceTurn = record.messages[messageIndex].turn
        after = positions[messageIndex++]
      }
      const tail = event.type === 'turn/end'
      if (event.type !== 'assistant/message' && !tail) continue
      const nextUser = record.messages[messageIndex]
      const before = tail && nextUser?.turn !== sourceTurn ? undefined : positions[messageIndex]
      if (sourceTurn && after !== undefined) {
        const stat = totals.get(record.id, sourceTurn, after, before ?? Number.MAX_SAFE_INTEGER)
        if (stat.count) placements.push({
          nativeTurn: event.data.turn, sourceTurn, start, anchor: event.seq, tail, after, before, ...stat,
        })
      }
      if (!tail) after = positions[messageIndex++]
    }
    return placements
  }, false)
}

export async function readHistoryPage(config, id, cursor, turn, {
  processOnly = false, after = 0, before = Number.MAX_SAFE_INTEGER, maxBytes = pageBytes,
} = {}) {
  if (!isSessionId(id)) return
  if (cursor && (typeof cursor !== 'string' || !cursor.startsWith(`${id}:`))) {
    throw Object.assign(new Error('历史页位置与会话不匹配。'), { status: 400 })
  }
  let position = cursorPosition(cursor && cursor.slice(id.length + 1))
  if (processOnly && cursor && (position[0] !== turn || position[1] <= after || position[1] >= before)) {
    throw Object.assign(new Error('历史页位置与回合不匹配。'), { status: 400 })
  }
  return use(config, db => {
    const snapshot = db.prepare(`SELECT json_extract(record,'$.history') AS history FROM snapshots
      WHERE id=? AND (state IN ('approved','done') OR (state='preview' AND created>=?))`).get(id, Date.now() - lifetime)
    if (!snapshot) return
    const history = JSON.parse(snapshot.history)
    if (!cursor && Number.isSafeInteger(turn) && turn > 0) {
      const start = db.prepare('SELECT 1 FROM entries WHERE snapshot_id=? AND turn=? LIMIT 1').get(id, turn)
      if (!start) return { history, items: [], nextCursor: null }
      position = [turn, 0, 0]
    }
    const range = processOnly
      ? `AND turn=? AND seq>? AND seq<? AND ${processKinds} AND json_extract(item,'$.branchId') IS NULL`
      : ''
    const rows = db.prepare(`SELECT seq,part,turn,call_id,item, COALESCE(turn,0) AS display_turn
      FROM entries WHERE snapshot_id=? ${range} AND (COALESCE(turn,0),seq,part)>(?,?,?) ORDER BY display_turn,seq,part LIMIT 41`)
      .iterate(id, ...(processOnly ? [turn, after, before, ...position] : position))
    const items = []
    const cursorTurn = cursor ? position[0] : undefined
    let bytes = 0
    let nextCursor = null
    let continuesTurn
    const find = db.prepare('SELECT item,COUNT(*) AS count FROM entries WHERE snapshot_id=? AND call_id=? AND kind=? AND part=0')
    for (const row of rows) {
      const length = Buffer.byteLength(row.item)
      if (items.length && (bytes + length > maxBytes || items.length >= 40)) {
        nextCursor = `${id}:${position.join(':')}`
        if (row.display_turn === position[0]) continuesTurn = row.display_turn
        break
      }
      const item = JSON.parse(row.item)
      if (item.kind === 'attachment' && row.call_id) {
        if (row.turn === null) delete item.turn
        else item.turn = row.turn
      } else if (item.kind === 'tool_result') {
        const call = row.call_id && find.get(id, row.call_id, 'tool_call')
        if (call?.count === 1) {
          const { turn, name } = JSON.parse(call.item)
          item.turn = turn
          item.name ??= name
        } else {
          delete item.turn
          item.status = 'unmatched'
        }
      } else if (item.kind === 'tool_call') {
        const call = row.call_id && find.get(id, row.call_id, 'tool_call')
        const result = call?.count === 1 && find.get(id, row.call_id, 'tool_result')
        item.status = result?.count ? JSON.parse(result.item).status ?? 'ok' : 'missing'
      }
      items.push(item)
      bytes += length
      position = [row.display_turn, row.seq, row.part]
    }
    return { history, items, nextCursor,
      ...(items.length && cursorTurn === (items[0].turn ?? 0) ? { continuedTurn: cursorTurn } : {}),
      ...(continuesTurn !== undefined ? { continuesTurn } : {}) }
  }, false)
}

export async function readHistoryAttachment(config, snapshotId, attachmentId, { seq, preview = false } = {}) {
  if (!isSessionId(snapshotId) || typeof attachmentId !== 'string' || !/^[0-9a-f]{64}$/.test(attachmentId)) return
  return use(config, db => {
    const state = preview
      ? "(s.state='approved' OR (s.state='preview' AND s.created>=?))"
      : "s.state='done'"
    const row = db.prepare(`
      SELECT a.bytes, json_extract(e.item, '$.name') AS name
      FROM attachments AS a
      JOIN snapshots AS s ON s.id=a.snapshot_id
      JOIN entries AS e ON e.snapshot_id=a.snapshot_id AND e.kind='attachment' AND e.part=0
        AND json_extract(e.item, '$.attachmentId')=a.hash
      WHERE a.snapshot_id=? AND a.hash=? AND (? IS NULL OR e.seq=?) AND ${state}
      ORDER BY e.seq LIMIT 1
    `).get(snapshotId, attachmentId, seq ?? null, seq ?? null, ...(preview ? [Date.now() - lifetime] : []))
    if (!row) return
    const bytes = Buffer.from(row.bytes)
    if (createHash('sha256').update(bytes).digest('hex') !== attachmentId) return
    return { bytes, name: row.name, mediaType: imageMediaType(bytes) ?? 'application/octet-stream' }
  }, false)
}
