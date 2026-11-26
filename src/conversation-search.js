import { canReadConversation, conversationId, conversationTitle, keyFor, redact } from './handoff.js'
import { dateMillis, readSourceEvents } from './projects.js'

const pageSize = 24
const sessionsPerPage = 32

function searchError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

export async function searchConversations(project, config, { query, cursor, signal }) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw searchError('请输入 1 至 200 个字符。')
  const term = query.trim()
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
  const archives = new Map()
  for (const archive of project.archives.filter(canReadConversation)
    .sort((a, b) => dateMillis(b.date) - dateMillis(a.date))) {
    const id = conversationId(archive)
    if (!archives.has(id)) archives.set(id, archive)
  }
  const sources = [...archives]
  const marker = keyFor(project.id, term, [...archives.keys()])
  const position = typeof cursor === 'string' && /^([a-f0-9]{24}):(\d{1,9}):(\d{1,9})$/.exec(cursor)
  if (cursor && (!position || position[1] !== marker)) throw searchError('来源列表已变化，请重新搜索。', 409)
  const start = Number(position?.[2] ?? 0)
  const skip = Number(position?.[3] ?? 0)
  const matches = []
  let incomplete = false
  const end = Math.min(sources.length, start + sessionsPerPage)
  for (let index = start; index < end; index++) {
    const [id, archive] = sources[index]
    let ordinal = 0
    for await (const event of readSourceEvents(archive, { sourceCwd: project.cwd, config, signal })) {
      signal?.throwIfAborted()
      if (event.kind === 'gap') incomplete = true
      if (event.kind !== 'message' || !event.turn) continue
      ordinal++
      if (index === start && ordinal <= skip) continue
      const body = redact(event.text)
      const match = pattern.exec(body)
      if (!match) continue
      const offset = match.index
      const from = Math.max(0, offset - 56)
      const to = Math.min(body.length, offset + match[0].length + 90)
      matches.push({
        id, agent: archive.agent ?? archive.kind, title: conversationTitle(archive.title), date: dateMillis(archive.date),
        role: event.role, turn: event.turn, offset, hash: keyFor(body),
        snippet: (from ? '…' : '') + body.slice(from, to) + (to < body.length ? '…' : ''),
        matchStart: offset - from + (from ? 1 : 0), matchLength: match[0].length,
      })
      if (matches.length === pageSize) return { matches, incomplete, nextCursor: `${marker}:${index}:${ordinal}` }
    }
  }
  return { matches, incomplete, ...(end < sources.length ? { nextCursor: `${marker}:${end}:0` } : {}) }
}
