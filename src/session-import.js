import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { saveSessionTrace } from './session-trace.js'
import { saveConversationSeed } from './conversation-store.js'
import { nativeTranscriptEvents } from './native-transcript.js'

export function nativeSessionServices(ctx) {
  const sessions = ctx.get?.('sessions')
  const persistence = ctx.get?.('sessionPersistence')
  const workspaces = ctx.get?.('workspaceRegistry')
  const projectionCache = ctx.get?.('sessionProjectionCache')
  if (!sessions?.prepare || !persistence?.create || !workspaces?.create) return undefined
  return { sessions, persistence, workspaces, projectionCache, attachments: ctx.get?.('attachments') }
}

export function nativeSessionEvents(messages, title, now = Date.now()) {
  const events = []
  let time = messages.find(message => message.time)?.time || now
  const add = (type, data, surfaceOp) => {
    events.push({ seq: events.length, time, type, data, ...(surfaceOp ? { surfaceOp } : {}) })
  }
  const message = (role, content, source) => ({ id: randomUUID(), role, content, source })
  let turn = 0
  let step = 0
  let replied = false
  let endReason
  const finish = () => {
    add('step/end', { turn, step })
    add('turn/end', { turn, reason: { kind: endReason ?? (replied ? 'completed' : 'interrupted') } })
  }
  for (const entry of messages) {
    const content = [{ type: 'text', text: entry.text }]
    if (entry.role === 'user') {
      if (turn) finish()
      time = Math.max(time, entry.time || 0)
      turn++
      step = 1
      replied = false
      endReason = entry.endReason
      add('turn/start', { turn })
      add('step/start', { turn, step })
      if (turn === 1) {
        // The current DSH system prompt replaces the empty first surface node on resume.
        add('system/message', { turn, step, message: message('system', [], { kind: 'system-prompt' }) }, 'append')
      }
      add('user/message', message('user', content, { kind: 'user' }), 'append')
      continue
    }
    if (replied) {
      add('step/end', { turn, step })
      step++
    }
    time = Math.max(time, entry.time || 0)
    if (replied) {
      add('step/start', { turn, step })
    }
    add('assistant/message', {
      turn, step, stream: [],
      message: message('assistant', content, { kind: 'model', provider: 'agent-bridge-import', model: 'imported' }),
    }, 'append')
    replied = true
  }
  finish()
  add('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
  return events
}

async function storeSeed(services, record, cwd) {
  const { sessions, persistence } = services
  let seed = record.seed
  if (!seed) {
    const { events, nativeTimeline } = record.id && record.config && record.history
      ? await nativeTranscriptEvents(record, services.attachments)
      : { events: nativeSessionEvents(record.messages, record.title) }
    const prepared = sessions.prepare(record.sessionId, { seed: events, meta: { cwd, createdAt: events[0].time } })
    if (prepared.header.version !== 4) {
      throw Object.assign(new Error('当前 DSH 的会话格式暂不支持历史迁入。'), { status: 409 })
    }
    seed = { header: prepared.header, events, ...(nativeTimeline ? { nativeTimeline } : {}) }
    if (record.id && record.config) seed = await saveConversationSeed(record.config, record.id, seed)
  }
  const { header, events } = seed
  const existing = await persistence.stat?.(record.sessionId)
  const handle = existing ? await persistence.open(record.sessionId, 'write') : await persistence.create(header)
  try {
    let offset = 0
    if (existing) {
      const loaded = (await handle.read(0, events.length + 1)).events
      if (handle.header.id !== header.id || handle.header.version !== header.version
        || handle.header.cwd !== header.cwd || loaded.length > events.length
        || !loaded.every((entry, index) => isDeepStrictEqual(JSON.parse(JSON.stringify(entry)), events[index]))) {
        throw Object.assign(new Error('目标会话的已有内容与迁入凭据不一致。'), { status: 409 })
      }
      offset = loaded.length
    }
    if (offset < events.length) await handle.append(events.slice(offset))
    await handle.flush()
    return seed
  } finally {
    await handle.close()
  }
}

export async function saveNativeSession(services, record, cwd) {
  const { workspaces, projectionCache } = services
  const workspace = await workspaces.create(cwd)
  const normalize = value => {
    const normalized = path.normalize(value)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  if (normalize(workspace.path) !== normalize(cwd)) {
    throw Object.assign(new Error('原工作目录已变化，请刷新项目。'), { status: 409 })
  }
  if (!record.stored && !workspace.sessionIds.includes(record.sessionId)) record.stored = await storeSeed(services, record, cwd)
  record.nativeTimeline = record.stored?.nativeTimeline ?? record.seed?.nativeTimeline
  // Save the reviewed source snapshot before attaching the new DSH session.
  const hasTrace = Array.isArray(record.trace) && record.trace.length > 0
  if (!record.traceStored && record.config && (hasTrace || record.sourceStats)) {
    try {
      const sourceStats = record.sourceStats && record.nativeTimeline
        ? { ...record.sourceStats, importedMessages: record.nativeTimeline.nativeMessages }
        : record.sourceStats
      const saved = await saveSessionTrace(record.config, record.sessionId, record.trace, sourceStats)
      record.traceStored = saved.saved === true
    } catch {
      throw Object.assign(
        new Error('会话历史已写入，但来源记录暂时无法保存。可重试。'),
        { status: 503 },
      )
    }
  }
  if (!workspace.sessionIds.includes(record.sessionId)) {
    projectionCache?.coldSnapshot(record.stored.header, 0, record.stored.events)
    await workspace.attachSession(record.sessionId)
  }
  return { sessionId: record.sessionId }
}
