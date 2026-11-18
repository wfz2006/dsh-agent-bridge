import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMarkdownFile, markdownExportSpans, parseMarkdown } from '../web/markdown.js'

const control = /[\u0000-\u001f\u007f]+/g

function clean(value, limit = 240) {
  return String(value ?? '').replace(control, ' ').trim().slice(0, limit)
}

function shortName(file) {
  return clean(String(file).replace(/[\\/]+$/, '').replace(/^.*[\\/]/, ''), 160)
}

function linkLabel(value) {
  return String(value ?? '').replace(/[\\[\]]/g, character => `\\${character}`)
}

function fileLink(label, target) {
  return `[${linkLabel(label)}](<${target}>)`
}

function directoryUrl(directory) {
  const href = pathToFileURL(directory).href
  return href.endsWith('/') ? href : `${href}/`
}

function relativeUrl(fromFile, target) {
  const relative = path.relative(path.dirname(fromFile), target)
  if (!relative || path.isAbsolute(relative)) return ''
  return relative.split(path.sep).map(segment => encodeURIComponent(segment)).join('/')
}

function projectRelative(root, target) {
  if (!path.isAbsolute(root) || !target || !path.isAbsolute(target)) return ''
  const relative = path.relative(root, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return ''
  return relative.split(path.sep).join('/')
}

function codeSpan(value) {
  const delimiter = '`'.repeat(1 + Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length)))
  const padding = /^[ `]|[ `]$/.test(value) ? ' ' : ''
  return `${delimiter}${padding}${value}${padding}${delimiter}`
}

function linkDestination(href, title) {
  const target = href.replace(/&/g, '&amp;').replace(/</g, '%3C').replace(/>/g, '%3E')
  // Keep a reference title in the same table cell and on the same source line.
  const tooltip = title ? ` "${title.replace(/[&"\\|\n\r]/g, char => `&#${char.charCodeAt(0)};`)}"` : ''
  return `(<${target}>${tooltip})`
}

function handoffBody(item, cwd, mode, savePath) {
  if (!isMarkdownFile(item.file)) return item.text
  const references = new Map((item.references ?? []).map(reference => [reference.href, reference]))
  const { links, definitions } = markdownExportSpans(item.text)
  // Materialize references before merging sections. A definition left in the
  // combined document could bind an unresolved label in another source.
  const edits = definitions.map(range => ({ ...range, text: '' }))
  let droppedThrough = 0
  for (const { href, start, labelEnd, end, relative, title } of links) {
    if (start < droppedThrough) continue
    let target = href
    if (relative) {
      const reference = references.get(href)
      const verified = reference?.verifiedFile
      target = ''
      if (projectRelative(cwd, verified)) {
        if (mode === 'local') target = pathToFileURL(verified).href.replace(/&/g, '%26')
        else if (savePath) target = relativeUrl(savePath, verified)
      }
      if (!target) {
        const caption = escapeProse(item.text.slice(start + 1, labelEnd - 1)).replace(/(?<!\\)[\[\]]/g, '\\$&')
        const label = projectRelative(cwd, reference?.path)
        edits.push({ start, end, text: label ? `${caption}（${codeSpan(label)}）` : caption })
        droppedThrough = end
        continue
      }
      target += href.match(/#[^\s<>]*$/)?.[0] ?? ''
    }
    edits.push({ start: labelEnd, end, text: linkDestination(target, title) })
  }
  let rewritten = ''
  let offset = 0
  for (const { start, end, text } of edits.sort((a, b) => a.start - b.start)) {
    rewritten += item.text.slice(offset, start) + text
    offset = end
  }
  return rewritten + item.text.slice(offset)
}

// Keep plain user text and source excerpts from changing the document structure.
function escapeProse(text) {
  return String(text ?? '').split('\n').map(line => {
    if (/^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:-{3,}|={3,}|\*{3,}|_{3,})[ \t]*$|`{3,}|~{3,})/.test(line)) {
      return line.replace(/^( {0,3})/, '$1\\')
    }
    return line
  }).join('\n')
}

function stamp(date) {
  return date.toISOString().slice(0, 19) + 'Z'
}

// Body sections are quoted source material, so their Markdown stays intact.
// An unbalanced fence would swallow the rest of the document, so it is closed
// at the end of its own section instead.
function fenceSafe(text) {
  const fence = parseMarkdown(text).at(-1)
  if (fence?.type !== 'fence') return text
  const lines = text.split(/\r\n|\n|\r/)
  const [start, end] = fence.map
  const closing = new RegExp(`^ {0,3}${fence.markup[0]}{${fence.markup.length},}[ \\t]*$`)
  if (end > start + 1 && closing.test(lines[end - 1])) return text
  const eol = text.match(/\r\n|\n|\r/)?.[0] ?? '\n'
  return `${text}${/\r$|\n$/.test(text) ? '' : eol}${fence.markup}`
}

export async function* sourceHistoryMarkdown(record, pages, { format, includeTrace }) {
  yield `# 外部会话来源历史\n\n${escapeProse(record.title || '迁入的 Agent 会话')}\n\n`
  if (format === 'local' && record.sourceCwd) {
    yield `来源目录 ${fileLink(shortName(record.sourceCwd), directoryUrl(record.sourceCwd))}\n\n`
  }
  if (!record.history.complete) yield '部分来源内容不可恢复，原因见下方记录。\n\n'
  let current
  function render(item) {
    if (!item) return ''
    const turn = item.turn ? ` · 第 ${item.turn} 轮` : ''
    if (item.kind === 'message') {
      return `## ${item.role === 'user' ? '用户' : '助手'}${turn}\n\n${fenceSafe(item.text)}\n\n`
    }
    if (item.kind === 'attachment') return `附件 ${escapeProse(item.name)}（${item.status === 'saved' ? '本机档案已保存' : item.status}）${turn}\n\n`
    if (item.kind === 'gap') return `来源缺失（${escapeProse(item.reason)}）\n\n`
    if (item.kind === 'turn_end') return `回合状态 ${item.status}${turn}\n\n`
    if (!includeTrace) return ''
    const label = { summary: '公开摘要', tool_call: '工具调用', tool_result: '工具结果' }[item.kind]
    return label ? `### ${label}${turn}\n\n${escapeProse([item.name, item.callId, item.status].filter(Boolean).join(' · '))}\n\n${fenceSafe(item.text ?? '')}\n\n` : ''
  }
  for await (const page of pages) {
    for (const item of page.items) {
      if (current?.seq === item.seq) current.text += item.text
      else {
        yield render(current)
        current = item
      }
    }
  }
  yield render(current)
}

function fileStamp(date) {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z'
}

function filenameOf(heading, date) {
  const name = heading.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+|[.-]+$/g, '')
  return `handoff-${Array.from(name).slice(0, 48).join('') || 'project'}-${fileStamp(date)}.md`
}

function sourceValue(file, { format, savePath }) {
  if (format === 'share') {
    const relative = savePath ? relativeUrl(savePath, file) : ''
    return relative ? fileLink(shortName(file), relative) : `\`${shortName(file)}\``
  }
  return fileLink(shortName(file), pathToFileURL(file).href)
}

function conversationHeading(label) {
  return clean(String(label ?? '').replace(/^近期会话\s*·\s*/, '')) || '消息'
}

const traceKinds = { summary: '思考摘要', tool_call: '工具调用', tool_result: '工具结果' }
const traceStates = {
  ok: '已完成', error: '失败', missing: '未记录结果', pending: '未完成', truncated: '已截取',
}

function traceLines(trace) {
  if (!Array.isArray(trace) || !trace.length) return []
  const lines = ['## 来源记录', '', '> 从旧 Agent 的会话记录中读取，只供查阅，不会重放任何工具调用。', '']
  let turn
  for (const item of trace.slice(0, 200)) {
    if (item.turn && item.turn !== turn) {
      turn = item.turn
      lines.push('', `### 第 ${turn} 轮`, '')
    }
    const kind = traceKinds[item?.kind] ?? '记录'
    const name = clean(item?.name, 120)
    const state = traceStates[item?.status] ?? ''
    const excerpt = item?.kind === 'tool_call' ? '' : clean(item?.text, 400)
    if (item?.kind === 'summary') {
      lines.push(`- ${[kind, excerpt].filter(Boolean).join(' · ')}`)
      continue
    }
    const callId = clean(item.callId, 200).replace(/`/g, '')
    lines.push(`- ${[kind, name && `\`${name.replace(/`/g, '')}\``, callId && `调用 \`${callId}\``, state,
      item.truncated && item.status !== 'truncated' && '已截取'].filter(Boolean).join(' · ')}`)
    if (excerpt) lines.push(`  - ${escapeProse(excerpt).replace(/\n/g, '\n    ')}`)
  }
  lines.push('')
  return lines
}

export function makeExport({
  title, origin, date = new Date(), preview = {}, prompt, truncated: legacyTruncated = false,
  format = 'local', savePath, includeTrace = false,
} = {}) {
  const heading = clean(title) || '项目交接'
  const session = origin === 'DSH 会话'
  const mode = format === 'share' ? 'share' : 'local'
  const exportFile = typeof savePath === 'string' && path.isAbsolute(savePath) ? savePath : undefined
  const legacy = typeof prompt === 'string' && prompt.trim() && !Array.isArray(preview.sections)
  const sections = Array.isArray(preview.sections)
    ? preview.sections.filter(item => item && typeof item.text === 'string' && item.text.trim())
    : []
  const conversation = sections.filter(item => item.conversation === true)
  const body = sections.filter(item => item.conversation !== true)
  const files = body.filter(item => typeof item.file === 'string' && item.file)
  const sources = (Array.isArray(preview.sources) ? preview.sources : [])
    .map(value => clean(value, 40)).filter(Boolean)
  const truncated = legacy ? legacyTruncated === true : preview.truncated === true

  const lines = [`# ${heading} · ${session ? '会话记录' : '开发交接'}`, '']
  const summary = [`来源：${sources.join('、') || clean(origin, 40) || '本地项目'}`, stamp(date)]
  if (files.length) summary.push(`${files.length} 份资料`)
  if (conversation.length) summary.push(`${conversation.length} 段对话`)
  lines.push(`> ${summary.join(' · ')}`, '')

  const cwd = typeof preview.cwd === 'string' && preview.cwd ? preview.cwd : ''
  if (cwd) {
    const name = clean(path.basename(cwd.replace(/[\\/]+$/, '')) || cwd, 120)
    const value = mode === 'share' ? `\`${name}\`` : fileLink(name, directoryUrl(cwd))
    lines.push(`**${session ? '原工作目录' : '工作目录'}**：${value}`, '')
  }

  if (legacy) {
    lines.push(fenceSafe(prompt), '')
    if (truncated) lines.push('> 部分内容已截取，完整内容见来源文件。', '')
    if (preview.footer) lines.push(`> ${clean(preview.footer, 200)}`, '')
    return { filename: filenameOf(heading, date), markdown: `${lines.join('\n').trimEnd()}\n` }
  }

  if (files.length) {
    lines.push('## 资料索引', '')
    for (const item of files) {
      lines.push(`- ${sourceValue(item.file, { format: mode, savePath: exportFile })}${item.label ? ` · ${linkLabel(clean(item.label))}` : ''}`)
    }
    lines.push('')
  }

  for (const item of body) {
    lines.push(`## ${clean(item.label) || '资料'}`, '')
    if (typeof item.file === 'string' && item.file) {
      lines.push(`来源：${sourceValue(item.file, { format: mode, savePath: exportFile })}`, '')
    }
    lines.push(fenceSafe(session ? item.text : handoffBody(item, cwd, mode, exportFile)), '')
  }

  if (conversation.length) {
    lines.push('## 最近对话', '')
    for (const item of conversation) {
      lines.push(`### ${conversationHeading(item.label)}`, '',
        item.markdown ? fenceSafe(item.text) : escapeProse(item.text.trimEnd()), '')
    }
  }

  if (includeTrace === true) lines.push(...traceLines(preview.trace))
  if (truncated) lines.push('> 部分内容已截取，完整内容见来源文件。', '')
  if (preview.footer) lines.push(`> ${clean(preview.footer, 200)}`, '')

  return { filename: filenameOf(heading, date), markdown: `${lines.join('\n').trimEnd()}\n` }
}
