import { randomUUID } from 'node:crypto'
import { readHistoryAttachment, readNativeTurns } from './conversation-store.js'

const modelSource = { kind: 'model', provider: 'agent-bridge-import', model: 'imported' }
const systemSource = { kind: 'system-prompt' }
const textBlock = text => ({ type: 'text', text })
const message = (role, content, source) => ({ id: randomUUID(), role, content, source })

async function attachmentBlock(record, item, attachments, { file = false } = {}) {
  if (item.attachmentId && attachments) {
    const saved = await readHistoryAttachment(record.config, record.id, item.attachmentId, { seq: item.seq, preview: true })
    if (saved) {
      const { bytes: data, mediaType, name } = saved
      try {
        if (mediaType.startsWith('image/') && attachments.saveImage) {
          return { type: 'image', attachment: await attachments.saveImage({ data, mediaType, name }) }
        }
        if (file && attachments.saveFile) return { type: 'file', attachment: await attachments.saveFile({ data, name }) }
      } catch { /* The exact bytes remain available in the source archive. */ }
    }
  }
  const name = item.name.replace(/[\\`*_[\]<>]/g, '\\$&')
  const status = item.status === 'saved' ? '原件见来源记录' : item.status === 'name-only' ? '仅保留文件名' : '原件不可用'
  return textBlock(`附件：${name}（${status}）`)
}

export async function nativeTranscriptEvents(record, attachments, now = Date.now()) {
  const events = []
  const usedCallIds = new Set()
  let time
  let turn = 0
  let step = 0
  let nativeMessages = 0
  let contextMessages = 0
  let nativeFirstTurn
  let nativeLastTurn
  let excluded = []
  const at = value => { time = Math.max(time ?? value ?? now, value ?? 0) }
  const add = (type, data, surface) => {
    const seq = events.length
    events.push({ seq, time, type, data, ...surface })
    return seq
  }
  const system = () => ({ turn, step, message: message('system', [], systemSource) })
  const leaveInHistory = () => {
    if (!excluded.length) return
    // Native surface replacement keeps the original events available to Chat
    // and Trajectory while an empty system node contributes no request message.
    add('system/message', system(), {
      surfaceOp: { op: 'replace', startSeq: excluded[0], endSeq: excluded.at(-1) },
      sourceEventSeqs: excluded,
    })
    excluded = []
  }
  const append = (type, data, retain, sourceEventSeqs) => {
    if (retain) leaveInHistory()
    const seq = add(type, data, { surfaceOp: 'append', ...(sourceEventSeqs && { sourceEventSeqs }) })
    if (!retain) excluded.push(seq)
    return seq
  }
  const openStep = () => add('step/start', { turn, step: ++step })
  const closeStep = () => add('step/end', { turn, step })

  for await (const { entries, initialTime } of readNativeTurns(record.config, record)) {
    const questions = new Map()
    let currentQuestion
    for (const item of entries) {
      if (item.role !== 'user') continue
      if (item.kind === 'message' || (item.kind === 'attachment' && (item.standalone || !currentQuestion))) {
        currentQuestion = item
        questions.set(item.seq, [])
      }
      if (item.kind === 'attachment') questions.get(currentQuestion.seq).push(item)
    }
    const question = entries.find(item => questions.has(item.seq))
    if (!question) continue
    nativeFirstTurn ??= question.turn
    nativeLastTurn = question.turn
    const results = new Map()
    const resultAttachments = new Map()
    for (const item of entries) {
      if (!item.callKey) continue
      const target = item.kind === 'tool_result' ? results : item.kind === 'attachment' ? resultAttachments : undefined
      if (!target) continue
      if (!target.has(item.callKey)) target.set(item.callKey, [])
      target.get(item.callKey).push(item)
    }

    time ??= initialTime
    at(question.time)
    add('turn/start', { turn: ++turn })
    step = 0
    openStep()
    if (turn === 1) add('system/message', system(), { surfaceOp: 'append' })
    let needsStep = false
    let replied = false
    let reasoning = []
    let calls = []
    const writeQuestion = async item => {
      if (needsStep) {
        openStep()
        needsStep = false
      }
      at(item.time)
      replied = false
      const files = questions.get(item.seq)
      const content = item.kind === 'message' ? [textBlock(item.text)] : []
      if (item.kind === 'message') nativeMessages++
      for (const file of files) {
        const block = await attachmentBlock(record, file, attachments, { file: true })
        if (block.type === 'text' && content.length) block.text = '\n\n' + block.text
        content.push(block)
      }
      const hasContext = item.contextText !== undefined
      if (hasContext) contextMessages++
      const userSeq = append('user/message', message('user', content, { kind: 'user' }), hasContext)
      if (hasContext && (item.text !== item.contextText || files.length)) {
        add('user/message', message('user', [textBlock(item.contextText)], { kind: 'agent-bridge-context' }), {
          surfaceOp: { op: 'replace', startSeq: userSeq, endSeq: userSeq },
          sourceEventSeqs: [userSeq],
        })
      }
      leaveInHistory()
    }
    const flush = async (reply, followingSeq) => {
      if (!reply && !reasoning.length && !calls.length) return
      if (needsStep) openStep()
      const content = reasoning.map(item => ({ type: 'reasoning', text: item.text }))
      if (reply) content.push(reply.kind === 'attachment' ? await attachmentBlock(record, reply, attachments) : textBlock(reply.text))
      for (const item of calls) content.push(item.block)
      at(reply?.time ?? reasoning.at(-1)?.time ?? calls[0]?.time)
      const keepReply = reply?.kind === 'message' && !reasoning.length && !calls.length && reply.contextText !== undefined
      const needsPrefix = keepReply && reply.text !== reply.contextText
      if (reply?.kind === 'message') nativeMessages++
      if (keepReply) contextMessages++
      if (needsPrefix) {
        // The host settles Chat and Trajectory from the last assistant message
        // of the step. Keep the reviewed prefix on the model surface and the
        // final, full settlement in the timeline.
        append('assistant/message', {
          turn, step, stream: [], message: message('assistant', [textBlock(reply.contextText)], modelSource),
        }, true)
      }
      append('assistant/message', {
        turn, step, stream: [], message: message('assistant', content, modelSource),
      }, keepReply && !needsPrefix)

      const settled = []
      for (const { entry, block } of calls) {
        at(entry.time)
        const callSeq = add('tool/call', {
          turn, step, callId: block.id, name: block.name, arguments: block.arguments,
        })
        const output = results.get(entry.callKey)
        if (output?.length) settled.push({ block, output, files: resultAttachments.get(entry.callKey) ?? [], callSeq })
      }
      settled.sort((a, b) => a.output[0].seq - b.output[0].seq)
      for (const { block, output, files, callSeq } of settled) {
        const last = output.at(-1)
        // A late result annotates the original call. Its source timestamp
        // remains in the archive and must not move subsequent replies forward.
        if (last.seq < followingSeq) at(last.time)
        const isError = ['error', 'incomplete'].includes(last.status)
        const outputBlocks = output.flatMap((item, index) => index
          ? [textBlock('\n\n---\n\n'), textBlock(item.text ?? '')]
          : [textBlock(item.text ?? '')])
        for (const item of files) outputBlocks.push(await attachmentBlock(record, item, attachments))
        append('tool/result', {
          turn, step,
          message: {
            ...message('tool', outputBlocks, { kind: 'tool', callId: block.id }),
            toolCallId: block.id, isError,
          },
        }, false, [callSeq])
      }
      leaveInHistory()
      closeStep()
      needsStep = true
      reasoning = []
      calls = []
    }

    for (const item of entries) {
      if (item.seq < question.seq) continue
      if (questions.has(item.seq)) {
        await flush(undefined, item.seq)
        await writeQuestion(item)
      } else if (item.kind === 'summary' && item.text?.trim()) {
        if (calls.length) await flush(undefined, item.seq)
        reasoning.push(item)
      } else if (item.kind === 'tool_call' && item.name) {
        let id = item.callId || `bridge-${item.seq}`
        if (usedCallIds.has(id)) id = randomUUID()
        usedCallIds.add(id)
        calls.push({ entry: item, block: { type: 'tool-call', id, name: item.name, arguments: item.text || '{}' } })
      } else if (item.kind === 'message' && item.role === 'assistant') {
        await flush(undefined, item.seq)
        await flush(item)
        replied = true
      } else if (item.kind === 'attachment' && item.role === 'assistant' && !item.callKey) {
        await flush(undefined, item.seq)
        await flush(item)
        replied = true
      }
    }
    await flush(undefined, 0)
    if (!needsStep) closeStep()
    const ending = entries.findLast(item => item.kind === 'turn_end')
    // DSH uses "interrupted" specifically for recovery after its own crash.
    const completed = ending ? ending.status === 'completed' : replied
    add('turn/end', { turn, reason: completed ? { kind: 'completed' } : { kind: 'aborted', reason: { kind: 'legacy' } } })
  }

  if (!turn) throw new Error('The approved source archive has no importable turns')
  add('session/title', { title: record.title, messageSeqs: [], source: { kind: 'user' } })
  return { events, nativeTimeline: { nativeMessages, nativeFirstTurn, nativeLastTurn, contextMessages } }
}
