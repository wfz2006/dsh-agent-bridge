import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { conversationTrace } from '../src/catalog.js'
import {
  isSessionId, normalizeTrace, readSessionTrace, saveSessionTrace, traceDirectory,
} from '../src/session-trace.js'

const sessionId = '3f0c2a10-6f4d-4c1f-9a0b-2c5d6e7f8091'
const trace = [
  { id: 't1', kind: 'summary', text: '先核对磁盘现场。', status: 'ok', messageIndex: 0 },
  { id: 't2', kind: 'tool_call', name: 'shell', callId: 'call-1', text: 'pnpm test', status: 'ok', messageIndex: 1 },
  { id: 't3', kind: 'tool_result', name: 'shell', callId: 'call-1', text: '90 passing', status: 'ok', messageIndex: 1, turn: 2 },
]

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-trace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { home: root, configFile: join(root, 'agent-bridge.json') }
  return { root, config }
}

test('a saved trace round-trips beside the bridge config with private permissions', async t => {
  const { root, config } = await fixture(t)
  assert.equal(traceDirectory(config), join(root, 'agent-bridge-traces'))
  const saved = await saveSessionTrace(config, sessionId, trace)
  assert.equal(saved.saved, true)
  assert.equal(saved.items, 3)
  const read = await readSessionTrace(config, sessionId.toUpperCase())
  assert.equal(read.sessionId, sessionId)
  assert.deepEqual(read.trace.map(item => [item.kind, item.id]), [
    ['summary', 't1'], ['tool_call', 't2'], ['tool_result', 't3'],
  ])
  assert.deepEqual(read.trace.at(-1), trace.at(-1))
  const files = await readdir(traceDirectory(config))
  assert.deepEqual(files, [`${sessionId}.json`])
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(traceDirectory(config), files[0]))).mode & 0o777, 0o600)
  }
  // No temporary file is left behind after the atomic rename.
  assert.equal(files.some(name => name.endsWith('.tmp')), false)
  const stored = JSON.parse(await readFile(join(traceDirectory(config), files[0]), 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.sessionId, sessionId)
})

test('repeating the same save is idempotent and does not accumulate files', async t => {
  const { config } = await fixture(t)
  await saveSessionTrace(config, sessionId, trace)
  const first = await readFile(join(traceDirectory(config), `${sessionId}.json`), 'utf8')
  await saveSessionTrace(config, sessionId, trace)
  const second = await readFile(join(traceDirectory(config), `${sessionId}.json`), 'utf8')
  assert.deepEqual(JSON.parse(second).trace, JSON.parse(first).trace)
  assert.deepEqual(await readdir(traceDirectory(config)), [`${sessionId}.json`])
})

test('a preview with long multibyte results remains readable after saving', async t => {
  const { config } = await fixture(t)
  const history = Array.from({ length: 24 }, (_, index) => ({
    ...trace[2], id: `result-${index}`, text: '中'.repeat(4096),
  }))
  const preview = conversationTrace(history, 2)
  assert.ok(Buffer.byteLength(JSON.stringify(preview.trace)) <= 48 * 1024)
  assert.equal(preview.truncated, true)
  assert.equal(preview.trace.at(-1).id, 'result-23')
  assert.ok(preview.trace.every(item => Buffer.byteLength(item.text) <= 4096 && /^[中]+$/u.test(item.text)))
  await saveSessionTrace(config, sessionId, preview.trace)
  assert.deepEqual((await readSessionTrace(config, sessionId))?.trace, preview.trace)
})

test('an empty or unknown trace is not written and an invalid session id is refused', async t => {
  const { config } = await fixture(t)
  assert.deepEqual(await saveSessionTrace(config, sessionId, []), { saved: false, items: 0 })
  assert.deepEqual(await saveSessionTrace(config, sessionId, [{ kind: 'unknown', text: 'x' }]), { saved: false, items: 0 })
  await assert.rejects(saveSessionTrace(config, '../../escape', trace), { status: 400 })
  assert.equal(isSessionId(sessionId), true)
  assert.equal(isSessionId('not-a-session'), false)
})

test('a corrupted, oversized, or mismatched trace file is ignored instead of trusted', async t => {
  const { root, config } = await fixture(t)
  const directory = traceDirectory(config)
  await mkdir(directory, { recursive: true })
  const file = join(directory, `${sessionId}.json`)
  await writeFile(file, '{not json')
  assert.equal(await readSessionTrace(config, sessionId), undefined)
  await writeFile(file, JSON.stringify({ version: 1, sessionId: 'another-id', trace }))
  assert.equal(await readSessionTrace(config, sessionId), undefined)
  await writeFile(file, JSON.stringify({ version: 2, sessionId, trace }))
  assert.equal(await readSessionTrace(config, sessionId), undefined)
  await writeFile(file, 'x'.repeat(96 * 1024 + 1))
  assert.equal(await readSessionTrace(config, sessionId), undefined)
  assert.equal(await readSessionTrace(config, '11111111-2222-3333-4444-555555555555'), undefined)
  assert.equal(root.length > 0, true)
})

test('normalization bounds text, drops unknown values, and keeps explicit truncation', () => {
  const [summary, call, result, minimal] = normalizeTrace([
    { id: 'a', kind: 'summary', text: 'x'.repeat(9000), status: 'weird', truncated: false },
    { id: 'b', kind: 'tool_call', text: 'y'.repeat(9000), status: 'error', messageIndex: -1 },
    { id: 'c', kind: 'tool_result', text: 'z'.repeat(5000), status: 'missing', truncated: true },
    { id: 'd', kind: 'tool_result', text: 'ok' },
  ])
  assert.equal(summary.text.length, 8192)
  assert.equal(summary.status, 'ok')
  assert.equal(Object.hasOwn(summary, 'truncated'), false)
  assert.equal(call.text.length, 8192)
  assert.equal(call.status, 'error')
  assert.equal(Object.hasOwn(call, 'messageIndex'), false)
  assert.equal(result.text.length, 4096)
  assert.equal(result.truncated, true)
  assert.equal(result.status, 'missing')
  assert.equal(minimal.status, 'ok')
  assert.equal(Object.hasOwn(minimal, 'name'), false)
})
