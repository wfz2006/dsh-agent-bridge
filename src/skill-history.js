import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readHistoryAttachment, readHistoryPage, stageConversation } from './conversation-store.js'
import { conversationId, conversationTitle, redact } from './handoff.js'
import { readConversationAttachment } from './history-attachment.js'
import { readSourceEvents } from './projects.js'
import { saveOutput } from './skill-output.js'

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
      return { file: await saveOutput(output, sourceHistoryMarkdown(record, pages(), { format, includeTrace })), history: record.history }
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
