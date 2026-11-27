import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readHistoryAttachment, readHistoryPage, stageConversation } from './conversation-store.js'
import { conversationId, conversationTitle, redact } from './handoff.js'
import { readConversationAttachment } from './history-attachment.js'
import { readSourceEvents } from './projects.js'
import { saveOutput } from './skill-output.js'
import { findShareFindings, privateKeyMarkers, redactShareMarkdown, shareReplacements } from '../web/share-redaction.js'

async function sourceVersion(archive) {
  const files = [archive.file, archive.file + '-wal']
  const versions = await Promise.all(files.map(async file => {
    const info = await stat(file, { bigint: true }).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    return info && [info.ino, info.size, info.mtimeNs].join(':')
  }))
  return createHash('sha256').update(JSON.stringify(versions)).digest('hex').slice(0, 20)
}

async function lastPrivateKeyEnd(readRecords) {
  let last = 0
  let index = 0
  for await (const text of readRecords()) {
    index++
    for (const marker of text.matchAll(privateKeyMarkers)) {
      if (marker[1] === 'END') {
        last = index
        break
      }
    }
  }
  return last
}

async function* shareHistoryMarkdown(readRecords) {
  // Records already join all stored parts and end at paragraph boundaries.
  // Only a PEM block can match across records. Look ahead in the immutable
  // snapshot once, on demand, so an unmatched BEGIN never swallows later text.
  let insideKey = false
  let lastEnd
  let index = 0
  for await (const text of readRecords()) {
    index++
    if (!text) continue
    const continued = insideKey
    let start = continued ? 0 : undefined
    let end
    for (const marker of text.matchAll(privateKeyMarkers)) {
      if (marker[1] === 'BEGIN') start ??= marker.index
      else {
        if (continued) end ??= marker.index + marker[0].length
        start = undefined
      }
    }
    if (continued && end === undefined) continue
    const fragments = continued ? [{ start: 0, end }] : []
    insideKey = false
    if (start !== undefined) {
      lastEnd ??= await lastPrivateKeyEnd(readRecords)
      if (index < lastEnd) {
        fragments.push({ start, end: text.length })
        insideKey = true
      }
    }
    const safe = redactShareMarkdown(text, findShareFindings(text, fragments))
    // The first fragment's placeholder was emitted with its opening record.
    yield continued ? safe.slice(shareReplacements.credential.length) : safe
  }
}

export async function readSkillHistory({ project, archive, config, turn, cursor, format, includeTrace, output, attachment }) {
  const sourceId = conversationId(archive)
  const version = await sourceVersion(archive)
  const cursorPrefix = `${sourceId}:${version}:${turn ?? 0}:`
  if (cursor && (!cursor.startsWith(cursorPrefix) || !/^\d+:\d+:\d+$/.test(cursor.slice(cursorPrefix.length)))) {
    throw new Error('历史分页位置已变化，请从该会话的第一页重新查看。')
  }
  const parent = await realpath(tmpdir())
  const scratch = await mkdtemp(path.join(parent, 'dsh-bridge-history-'))
  const storage = { configFile: path.join(scratch, 'agent-bridge.json') }
  const id = randomUUID()
  try {
    const record = await stageConversation(storage, {
      id, sessionId: randomUUID(), projectId: project.id, sourceId,
      sourceCwd: project.cwd, title: conversationTitle(archive.title) || '来源会话',
    }, readSourceEvents(archive, { config, sourceCwd: project.cwd }), redact,
    item => readConversationAttachment(project, archive, item))
    if (attachment) {
      const item = await readHistoryAttachment(storage, id, attachment, { preview: true })
      if (!item) throw new Error('这条会话中没有可取回的该附件。')
      return { file: await saveOutput(output, [item.bytes]), name: item.name, bytes: item.bytes.length }
    }

    async function pageAt(position) {
      const page = await readHistoryPage(storage, id, position, turn, { maxBytes: output ? undefined : 14 * 1024 })
      if (turn !== undefined && page.items.some(item => item.turn !== turn)) {
        return { ...page, items: page.items.filter(item => item.turn === turn), nextCursor: null }
      }
      return page
    }
    if (output) {
      const { sourceHistoryMarkdown } = await import('./export.js')
      async function* pages() {
        let position
        do {
          const page = await pageAt(position)
          yield page
          position = page.nextCursor
        } while (position)
      }
      const readRecords = () => sourceHistoryMarkdown(record, pages(), { format, includeTrace })
      const markdown = format === 'share' ? shareHistoryMarkdown(readRecords) : readRecords()
      return { file: await saveOutput(output, markdown), history: record.history }
    }
    const page = await pageAt(cursor && `${id}:${cursor.slice(cursorPrefix.length)}`)
    return {
      ...page, title: record.title, sourceStats: record.sourceStats, usedSkills: record.usedSkills,
      nextCursor: page.nextCursor ? cursorPrefix + page.nextCursor.slice(id.length + 1) : null,
    }
  } finally {
    const checked = await realpath(scratch)
    if (path.dirname(checked) === parent && path.basename(checked).startsWith('dsh-bridge-history-')) {
      await rm(checked, { recursive: true, force: true })
    }
  }
}
