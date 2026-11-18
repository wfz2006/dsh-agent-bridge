import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { stageConversation, readHistoryPage, readStoredConversation, approveConversation, finishConversation, rebindConversation } from '../src/conversation-store.js'
import { saveNativeSession } from '../src/session-import.js'
import { nativeTranscriptEvents } from '../src/native-transcript.js'

async function nativeFixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-edge-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { configFile: join(root, 'agent-bridge.json') }
  const record = await stageConversation(config, { id: randomUUID(), sessionId: randomUUID(), title: 'Edge' }, source, String)
  const { events, nativeTimeline } = await nativeTranscriptEvents({ ...record, config }, undefined, 1800000000000)
  return { record, config, events, nativeTimeline }
}

const input = (text, turn = 1, time) => ({ kind: 'message', role: 'user', turn, text, time })
const reply = (text, turn = 1, time) => ({ kind: 'message', role: 'assistant', turn, text, time })
const invocation = (callId, name = 'read') => ({ kind: 'tool_call', turn: 1, callId, name, text: '{}' })
const output = (callId, text) => ({ kind: 'tool_result', callId, text })

test('the full long reply remains in history and the reviewed prefix retains its assistant role on resume', async t => {
  const full = '答😀'.repeat(9000)
  const { record, events, nativeTimeline } = await nativeFixture(t, [input('Q'), reply(full)])
  const surface = new Map()
  for (const event of events) {
    if (event.surfaceOp === 'append') surface.set(event.seq, event)
    else if (event.surfaceOp?.op === 'replace') {
      for (const seq of surface.keys()) {
        if (seq >= event.surfaceOp.startSeq && seq <= event.surfaceOp.endSeq) surface.delete(seq)
      }
      surface.set(event.seq, event)
    }
  }
  assert.equal(events.findLast(event => event.type === 'assistant/message').data.message.content[0].text, full)
  const kept = [...surface.values()].filter(event => event.type === 'assistant/message')
  assert.equal(kept.length, 1)
  assert.equal(kept[0].data.message.content[0].text, record.messages[1].text)
  assert.equal(nativeTimeline.contextMessages, 2)
})

test('reused tool ids pair when calls settle in sequence and ambiguous or missing ids remain visible in the source', async t => {
  const { record, config, events } = await nativeFixture(t, [
    input('Q'),
    invocation('same', 'first'), output('same', 'one'),
    invocation('same', 'second'), output('same', 'two'),
    invocation('conflict', 'left'), invocation('conflict', 'right'), output('conflict', 'ambiguous'),
    invocation(undefined), output(undefined, 'no id'), output('absent', 'orphan'),
    reply('Done'),
  ])
  assert.equal(record.history.complete, false)
  assert.equal(record.history.gaps, 3)
  const calls = new Map(events.filter(event => event.type === 'tool/call').map(event => [event.seq, event.data]))
  const pairs = events.filter(event => event.type === 'tool/result')
    .map(event => [calls.get(event.sourceEventSeqs[0]).name, event.data.message.content[0].text])
  assert.deepEqual(pairs, [['first', 'one'], ['second', 'two']])
  const page = await readHistoryPage(config, record.id)
  assert.deepEqual(page.items.filter(item => item.status === 'unmatched').map(item => item.text), ['ambiguous', 'no id', 'orphan'])
})

test('one tool invocation retains a visible boundary between results', async t => {
  const { events } = await nativeFixture(t, [input('Q'), invocation('a'), output('a', 'FIRST'), output('a', 'SECOND'), reply('Done')])
  const result = events.find(event => event.type === 'tool/result')
  assert.match(result.data.message.content.map(block => block.text).join(''), /^FIRST\s+---\s+SECOND$/)
})

test('repeated user messages keep their source step order and missing leading time does not overwrite recorded dates', async t => {
  const time = 1700000000000
  const { events, nativeTimeline } = await nativeFixture(t, [
    input('first'), reply('first reply'), input('second'), reply('second reply', 1, time),
    input('later', 2, time + 1000), reply('later reply', 2, time + 2000),
  ])
  assert.deepEqual(events.flatMap(event => {
    if (event.type === 'user/message') return [event.data.content[0].text]
    if (event.type === 'assistant/message') return [event.data.message.content[0].text]
    return []
  }), ['first', 'first reply', 'second', 'second reply', 'later', 'later reply'])
  assert.deepEqual(events.filter(event => event.type === 'user/message').map(event => event.time), [time, time, time + 1000])
  assert.equal(nativeTimeline.nativeMessages, 6)
})

test('the paged archive preserves all text while projecting only recent messages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { configFile: join(root, 'agent-bridge.json') }
  const id = randomUUID()
  const sessionId = randomUUID()
  const large = '# C#\r\n\r\n```csharp\r\n' + '中😀'.repeat(35000) + '\r\n\r\n```'
  async function* events() {
    yield { kind: 'message', role: 'user', text: 'first', turn: 1 }
    yield { kind: 'message', role: 'assistant', text: large, turn: 1 }
    yield { kind: 'tool_call', text: 'secretValue', callId: 'call-a', name: 'read', turn: 1 }
    for (let turn = 2; turn <= 360; turn++) {
      yield { kind: 'message', role: 'user', text: 'same', turn }
      yield { kind: 'message', role: 'assistant', text: 'same', turn }
    }
    yield { kind: 'tool_result', text: 'late', callId: 'call-a', turn: 360 }
    yield { kind: 'gap', reason: 'source-compacted' }
  }
  const stored = await stageConversation(config, { id, sessionId, sourceCwd: root, targetCwd: root, projectId: 'project' },
    events(), value => value.replace('secretValue', '[已隐藏]'))
  assert.equal(stored.history.messages, 720)
  assert.equal(stored.messages.length, 600)
  assert.equal(stored.history.complete, false)
  assert.equal(await readStoredConversation(config, sessionId), undefined)
  await approveConversation(config, id)
  await finishConversation(config, id)
  const rows = []
  let previousPage
  let cursor
  do {
    const page = await readHistoryPage(config, id, cursor)
    if (previousPage) {
      const first = page.items[0].turn ?? 0
      const last = previousPage.items.at(-1).turn ?? 0
      const continuation = first === last ? first : undefined
      assert.equal(previousPage.continuesTurn, continuation)
      assert.equal(page.continuedTurn, continuation)
    }
    previousPage = page
    rows.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(rows.filter(row => row.role === 'assistant' && row.turn === 1).map(row => row.text).join(''), large)
  assert.equal(rows.find(row => row.kind === 'tool_result').turn, 1)
  assert.ok(rows.findIndex(row => row.kind === 'tool_result') < rows.findIndex(row => row.turn === 2))
  assert.equal(rows.find(row => row.kind === 'tool_call').text, '[已隐藏]')
  assert.equal((await readStoredConversation(config, sessionId)).history.snapshotId, id)
})

test('rebinding gives the exact reviewed archive a fresh receipt and rejects old cursors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-history-rebind-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { configFile: join(root, 'agent-bridge.json') }
  const id = randomUUID()
  async function* source() {
    for (let turn = 1; turn <= 50; turn++) yield { kind: 'message', role: 'user', turn, text: 'reviewed' }
  }
  const before = await stageConversation(config, { id, sessionId: randomUUID(), projectId: 'project', sourceId: 'source' }, source(), String)
  const oldPage = await readHistoryPage(config, id)
  assert.ok(oldPage.nextCursor)
  assert.equal(oldPage.continuesTurn, undefined)
  const changed = await rebindConversation(config, before, { id: randomUUID(), sessionId: randomUUID(), targetCwd: root })
  assert.equal(await readHistoryPage(config, id), undefined)
  await assert.rejects(readHistoryPage(config, changed.id, oldPage.nextCursor), { status: 400 })
  assert.deepEqual((await readHistoryPage(config, changed.id)).items, oldPage.items)
  assert.equal(await approveConversation(config, id), 0)
})

test('retrying a partially written native seed after restart appends only the original remainder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { configFile: join(root, 'agent-bridge.json') }
  const id = randomUUID()
  const sessionId = randomUUID()
  async function* source() {
    yield { kind: 'message', role: 'user', turn: 1, text: 'question' }
    yield { kind: 'message', role: 'assistant', turn: 1, text: 'checking' }
    yield { kind: 'turn_end', turn: 1, status: 'interrupted' }
  }
  const record = await stageConversation(config, { id, sessionId }, source(), String)
  await approveConversation(config, id)
  let header
  let creates = 0
  const log = []
  const workspace = { path: root, sessionIds: [], attachSession: async value => workspace.sessionIds.push(value) }
  const services = {
    workspaces: { create: async () => workspace },
    sessions: { prepare: (id, { meta }) => ({ header: { id, version: 4, ...meta } }) },
    persistence: {
      stat: async () => header && { header },
      create: async value => {
        creates++
        header = value
        return { append: async entries => { log.push(...entries.slice(0, 3)); throw new Error('stopped') }, close: async () => {} }
      },
      open: async () => ({
        header, read: async () => ({ events: [...log] }),
        append: async entries => log.push(...entries), flush: async () => {}, close: async () => {},
      }),
    },
  }
  await assert.rejects(saveNativeSession(services, { ...record, config, title: 'test' }, root), /stopped/)
  const first = structuredClone(log)
  assert.deepEqual(await saveNativeSession(services, { ...record, config, title: 'test' }, root), { sessionId })
  assert.equal(creates, 1)
  assert.deepEqual(log.slice(0, first.length), first)
  assert.equal(log.filter(event => event.type === 'user/message').length, 1)
  assert.deepEqual(log.find(event => event.type === 'turn/end').data.reason, { kind: 'aborted', reason: { kind: 'legacy' } })
  assert.deepEqual(workspace.sessionIds, [sessionId])
})
