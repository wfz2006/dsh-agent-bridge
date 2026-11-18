import MarkdownIt from './vendor/markdown-it.mjs'

const maxNesting = 48
const parser = new MarkdownIt({ html: false, linkify: true, maxNesting })
parser.linkify.set({ fuzzyLink: false, fuzzyEmail: false })
// Destinations are handled by the DOM renderer below, never by an HTML renderer.
// Retain the label even when a destination is disallowed.
parser.validateLink = () => true

// The bundled parser validates inline and reference-style syntax. Capture the
// consumed span there rather than searching the rendered labels or destinations.
for (const [name, type] of [['link', 'link_open'], ['image', 'image']]) {
  const { fn, alt } = parser.inline.ruler.__rules__.find(rule => rule.name === name)
  const isLink = name === 'link'
  parser.inline.ruler.at(name, (state, silent) => {
    if (silent || !state.env.captureLinks) return fn(state, silent)
    const start = state.pos
    const index = state.tokens.length
    if (!fn(state, false)) return false
    const token = state.tokens.slice(index).find(token => token.type === type)
    if (token) {
      const bracket = isLink ? start : start + 1
      const labelEnd = state.md.helpers.parseLinkLabel(state, bracket, isLink) + 1
      token.meta = { ...token.meta, span: { start, bracket, labelEnd, end: state.pos } }
    }
    return true
  }, { alt })
}

const referenceRule = parser.block.ruler.__rules__.find(rule => rule.name === 'reference')
const parseReference = referenceRule.fn
parser.block.ruler.at('reference', (state, start, end, silent) => {
  if (!parseReference(state, start, end, silent)) return false
  if (!silent && state.env.captureLinks) {
    for (let line = start; line < state.line; line++) {
      const position = state.bMarks[line] + state.tShift[line]
      const column = position - state.src.lastIndexOf('\n', position - 1) - 1
      state.env.definitionLines.push({ line, column })
    }
  }
  return true
}, { alt: referenceRule.alt })

const externalHref = /^(?:https?:\/\/|mailto:)[^\s\u0000-\u001f]+$/i
const markdownLimit = 96 * 1024

export const isMarkdownFile = file => typeof file === 'string' && /\.(?:md|markdown|mdx)$/i.test(file)
export const isRelativeReference = href => Boolean(href && !/^(?:[/?#\\]|[a-z][a-z\d+.-]*:)/i.test(href))

export function parseMarkdown(source) {
  return parser.parse(source.slice(0, markdownLimit), {})
}

export function relativeMarkdownLinks(source) {
  return [...new Set(parseMarkdown(source).flatMap(token => (token.children ?? [])
    .filter(child => child.type === 'link_open')
    .map(child => child.attrGet('href'))
    .filter(isRelativeReference)))]
}

function sourceLines(source) {
  let offset = 0
  return source.split(/(\r\n|\r|\n)/).flatMap((part, index) => {
    const start = offset
    offset += part.length
    return index % 2 ? [] : [{ text: part, start }]
  })
}

// Paragraphs and headings retain a line map even inside quotes and lists. In
// tables the row has the line map, and the block parser removes escapes on pipes.
function tableLine(line) {
  const offsets = []
  let text = ''
  for (let index = 0; index < line.text.length; index++) {
    offsets.push(line.start + index)
    if (line.text[index] === '\\' && line.text[index + 1] === '|') index++
    text += line.text[index]
  }
  offsets.push(line.start + line.text.length)
  return { text, offsets }
}

function inlinePositions(content, lines, first, table) {
  const positions = []
  const pieces = content.split('\n')
  for (const [index, piece] of pieces.entries()) {
    const line = table ?? lines[first + index]
    if (!line) return undefined
    // Indentation can contain spaces inserted by Markdown-it to expand a tab.
    const body = piece.trimStart()
    const column = line.text.indexOf(body, table?.column ?? 0)
    if (column < 0) return undefined
    const indent = piece.length - body.length
    for (let index = 0; index <= piece.length; index++) {
      const position = column + Math.max(0, index - indent)
      positions.push(line.offsets ? line.offsets[position] : line.start + position)
    }
    if (table) table.column = column + body.length
  }
  return positions
}

export function markdownExportSpans(source) {
  const lines = sourceLines(source)
  const env = { captureLinks: true, definitionLines: [] }
  const tokens = parser.parse(source.slice(0, markdownLimit), env)
  const links = []
  // Leave original line endings and surrounding list/quote prefixes.
  const definitions = env.definitionLines.map(({ line, column }) => ({
    start: lines[line].start + column, end: lines[line].start + lines[line].text.length,
  }))
  let table
  for (const token of tokens) {
    if (token.type === 'tr_open') table = { ...tableLine(lines[token.map[0]]), column: 0 }
    if (token.type === 'tr_close') table = undefined
    if (token.type !== 'inline' || (!token.map && !table)) continue
    const positions = inlinePositions(token.content, lines, token.map?.[0], table)
    if (!positions) continue
    for (const child of token.children) {
      const span = child.meta?.span
      if (!span) continue
      const href = child.attrGet(child.type === 'image' ? 'src' : 'href')
      const relative = child.type === 'link_open' && isRelativeReference(href)
      if (!relative && !child.meta.label) continue
      const start = positions[span.start]
      const labelEnd = positions[span.labelEnd]
      const end = positions[span.end]
      if (source[positions[span.bracket]] === '[' && source[labelEnd - 1] === ']' && end >= labelEnd) {
        links.push({ start, labelEnd, end, href, relative, title: child.attrGet('title') })
      }
    }
  }
  return { links, definitions }
}

const classes = {
  paragraph: 'md-paragraph', heading: 'md-heading', bullet_list: 'md-list', ordered_list: 'md-list',
  blockquote: 'md-quote', table: 'md-table',
}

export function renderMarkdown(source, document = globalThis.document, referenceLink) {
  const fragment = document.createDocumentFragment()
  const stack = [fragment]
  const element = (tag, className, content) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (content !== undefined) node.textContent = content
    return node
  }
  function render(tokens) {
    for (const token of tokens) {
      if (token.hidden) continue
      const parent = stack.at(-1)
      if (token.nesting === -1) {
        stack.pop()
        continue
      }
      if (token.nesting === 1) {
        const type = token.type.slice(0, -5)
        let node
        if (type === 'link') {
          const href = token.attrGet('href')
          if (externalHref.test(href)) {
            node = element('a', 'md-link')
            node.setAttribute('href', href)
            node.setAttribute('target', '_blank')
            node.setAttribute('rel', 'noopener noreferrer')
          } else if (referenceLink && isRelativeReference(href)) {
            const reference = referenceLink(href)
            if (reference) {
              parent.append(reference.container)
              stack.push(reference.label)
              continue
            }
          }
        } else {
          const tag = type === 'heading' ? `h${Math.min(6, Number(token.tag[1]) + 1)}` : token.tag
          node = element(tag, classes[type])
          const start = token.attrGet('start')
          if (start && /^\d+$/.test(start)) node.setAttribute('start', start)
          const alignment = /^text-align:(left|center|right)$/.exec(token.attrGet('style'))
          if (alignment) node.className = `md-align-${alignment[1]}`
        }
        if (!node) {
          stack.push(parent)
          continue
        }
        if (type === 'table') {
          const wrap = element('div', 'md-table-wrap')
          wrap.append(node)
          parent.append(wrap)
        } else parent.append(node)
        stack.push(node)
        continue
      }
      if (token.type === 'inline') {
        const first = token.children?.[0]
        const task = stack.findLast(node => node.tagName?.toLowerCase() === 'li')
        const marker = task && first?.type === 'text' && /^\[([ xX])\]\s+/.exec(first.content)
        if (marker && !task.className) {
          task.className = 'md-task'
          const box = element('span', 'md-task-box', marker[1] === ' ' ? '☐' : '☑')
          parent.append(box)
          render([{ ...first, content: first.content.slice(marker[0].length) }, ...token.children.slice(1)])
        } else if (token.children) render(token.children)
      } else if (token.type === 'text') parent.append(document.createTextNode(token.content))
      else if (token.type === 'code_inline') parent.append(element('code', 'md-code', token.content))
      else if (token.type === 'fence' || token.type === 'code_block') {
        const pre = element('pre', 'md-block')
        const language = /^[\w+-]+/.exec(token.info.trim())?.[0]
        pre.append(element('code', language ? `language-${language}` : '', token.content))
        parent.append(pre)
      } else if (token.type === 'hardbreak') parent.append(element('br'))
      else if (token.type === 'softbreak') parent.append(document.createTextNode('\n'))
      else if (token.type === 'hr') parent.append(element('hr', 'md-rule'))
      else if (token.type === 'image') parent.append(element('span', 'md-image', token.content))
    }
  }
  const tokens = parseMarkdown(source)
  if (tokens.some(token => token.level >= maxNesting - 1)) {
    fragment.append(element('p', 'md-paragraph', source.slice(0, markdownLimit)))
  } else render(tokens)
  return fragment
}
