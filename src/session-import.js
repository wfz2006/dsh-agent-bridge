import { randomUUID } from 'node:crypto'
import path from 'node:path'

export function nativeSessionServices(ctx) {
  const sessions = ctx.get?.('sessions')
  const persistence = ctx.get?.('sessionPersistence')
  const workspaces = ctx.get?.('workspaceRegistry')
  const projectionCache = ctx.get?.('sessionProjectionCache')
  if (!sessions?.prepare || !persistence?.create || !workspaces?.create) return undefined
  return { sessions, persistence, workspaces, projectionCache }
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
  const finish = () => {
    add('step/end', { turn, step })
    add('turn/end', { turn, reason: { kind: replied ? 'completed' : 'interrupted' } })
  }
  for (const entry of messages) {
    const content = [{ type: 'text', text: entry.text }]
    if (entry.role === 'user') {
      if (turn) finish()
      time = Math.max(time, entry.time || 0)
      turn++
      step = 1
      replied = false
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

export async function saveNativeSession(services, record, cwd) {
  const { sessions, persistence, workspaces, projectionCache } = services
  const workspace = await workspaces.create(cwd)
  const normalize = value => {
    const normalized = path.normalize(value)
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  if (normalize(workspace.path) !== normalize(cwd)) {
    throw Object.assign(new Error('原工作目录已变化，请刷新项目。'), { status: 409 })
  }
  if (!record.stored) {
    const events = nativeSessionEvents(record.messages, record.title)
    const prepared = sessions.prepare(record.sessionId, { seed: events, meta: { cwd, createdAt: events[0].time } })
    if (prepared.header.version !== 4) {
      throw Object.assign(new Error('当前 DSH 的会话格式暂不支持历史迁入。'), { status: 409 })
    }
    const handle = await persistence.create(prepared.header)
    try {
      await handle.append(events)
      await handle.flush()
      record.stored = { header: prepared.header, events }
    } finally {
      await handle.close()
    }
  }
  if (!workspace.sessionIds.includes(record.sessionId)) {
    projectionCache?.coldSnapshot(record.stored.header, 0, record.stored.events)
    await workspace.attachSession(record.sessionId)
  }
  return { sessionId: record.sessionId }
}
