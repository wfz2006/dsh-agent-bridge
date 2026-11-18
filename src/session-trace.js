import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const kinds = new Set(['summary', 'tool_call', 'tool_result'])
const states = new Set(['ok', 'error', 'missing', 'pending', 'truncated', 'incomplete'])
const maxTraceItems = 200
const maxTraceBytes = 96 * 1024

export function traceDirectory(config) {
  const base = path.dirname(config.configFile ?? path.join(config.home ?? '.', 'agent-bridge.json'))
  return path.join(base, 'agent-bridge-traces')
}

export function isSessionId(value) {
  return typeof value === 'string' && sessionIdPattern.test(value)
}

function clean(value, limit) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, limit)
}

export function normalizeTrace(trace) {
  if (!Array.isArray(trace)) return []
  const items = []
  for (const item of trace.slice(0, maxTraceItems)) {
    if (!item || !kinds.has(item.kind)) continue
    items.push({
      id: clean(item.id, 200),
      kind: item.kind,
      ...(item.name ? { name: clean(item.name, 120) } : {}),
      ...(item.callId ? { callId: clean(item.callId, 200) } : {}),
      text: clean(item.text, item.kind === 'tool_result' ? 4096 : 8192),
      status: states.has(item.status) ? item.status : 'ok',
      ...(item.truncated === true ? { truncated: true } : {}),
      ...(Number.isFinite(item.time) && item.time > 0 ? { time: item.time } : {}),
      ...(Number.isInteger(item.messageIndex) && item.messageIndex >= 0 ? { messageIndex: item.messageIndex } : {}),
      ...(Number.isSafeInteger(item.turn) && item.turn > 0 ? { turn: item.turn } : {}),
    })
  }
  return items
}

export function countTrace(trace) {
  const counts = { summary: 0, toolCall: 0, toolResult: 0, failed: 0, missing: 0 }
  for (const item of trace) {
    if (item.kind === 'summary') counts.summary++
    else if (item.kind === 'tool_call') {
      counts.toolCall++
      if (item.status === 'error') counts.failed++
      if (item.status === 'missing') counts.missing++
    } else if (item.kind === 'tool_result') counts.toolResult++
  }
  return counts
}

function normalizeSourceStats(value) {
  if (!value || typeof value !== 'object') return undefined
  const { userMessages, assistantMessages, importedMessages, partial, elapsedMs, tokens } = value
  const nonNegative = number => Number.isSafeInteger(number) && number >= 0
  if (![userMessages, assistantMessages, importedMessages].every(nonNegative)
    || userMessages === 0 || importedMessages === 0 || !Number.isSafeInteger(userMessages + assistantMessages)
    || importedMessages > userMessages + assistantMessages) return undefined
  const stats = { userMessages, assistantMessages, importedMessages, partial: partial === true }
  if (nonNegative(elapsedMs)) stats.elapsedMs = elapsedMs
  if (nonNegative(tokens?.total)) {
    stats.tokens = { total: tokens.total }
    for (const name of ['input', 'output']) {
      if (nonNegative(tokens[name]) && tokens[name] <= tokens.total) stats.tokens[name] = tokens[name]
    }
  }
  return stats
}

function traceFile(config, sessionId) {
  if (!isSessionId(sessionId)) throw Object.assign(new Error('会话标识无效。'), { status: 400 })
  return path.join(traceDirectory(config), `${sessionId.toLowerCase()}.json`)
}

export async function saveSessionTrace(config, sessionId, trace, sourceStats) {
  const items = normalizeTrace(trace)
  const stats = normalizeSourceStats(sourceStats)
  if (!items.length && !stats) return { saved: false, items: 0 }
  const target = traceFile(config, sessionId)
  const body = `${JSON.stringify({
    version: 1, sessionId: sessionId.toLowerCase(), savedAt: new Date().toISOString(), trace: items,
    ...(stats ? { sourceStats: stats } : {}),
  })}\n`
  if (Buffer.byteLength(body) > maxTraceBytes) throw new RangeError('来源记录超过存储上限。')
  const directory = traceDirectory(config)
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(body, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return { saved: true, items: items.length, file: target }
}

export async function readSessionTrace(config, sessionId) {
  const file = traceFile(config, sessionId)
  let info
  try { info = await stat(file) } catch { return undefined }
  if (!info.isFile() || info.size > maxTraceBytes) return undefined
  let parsed
  try { parsed = JSON.parse(await readFile(file, 'utf8')) } catch { return undefined }
  if (parsed?.version !== 1 || parsed.sessionId !== sessionId.toLowerCase() || !Array.isArray(parsed.trace)) return undefined
  const stats = normalizeSourceStats(parsed.sourceStats)
  return { sessionId: parsed.sessionId, savedAt: parsed.savedAt, trace: normalizeTrace(parsed.trace),
    ...(stats ? { sourceStats: stats } : {}) }
}
