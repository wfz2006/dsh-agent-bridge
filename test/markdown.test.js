import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parseMarkdown, relativeMarkdownLinks, renderMarkdown } from '../web/markdown.js'

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName
    this.children = []
    this.attributes = {}
    this.dataset = {}
    this.className = ''
    this._text = ''
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') this.children.push(new FakeNode('#text', node))
      else this.children.push(node)
    }
  }

  setAttribute(name, value) { this.attributes[name] = String(value) }

  set textContent(value) {
    this.children = []
    this._text = String(value)
  }

  get textContent() {
    if (this._text) return this._text
    return this.children.map(child => child.textContent).join('')
  }
}

const document = {
  createElement: tag => new FakeNode(tag),
  createTextNode: value => {
    const node = new FakeNode('#text')
    node.textContent = value
    return node
  },
  createDocumentFragment: () => new FakeNode('#fragment'),
}

function walk(node, visit) {
  visit(node)
  for (const child of node.children) walk(child, visit)
}

function select(fragment, tagName) {
  const found = []
  walk(fragment, node => { if (node.tagName === tagName) found.push(node) })
  return found
}

function textOf(fragment) {
  return fragment.textContent
}

test('markdown preview builds real structure instead of one preformatted blob', () => {
  const fragment = renderMarkdown([
    '# 项目交接',
    '',
    '先读 **设计** 和 `scripts/build.mjs`。',
    '',
    '- 第一项',
    '- 第二项',
    '  - 子项',
    '',
    '1. 步骤一',
    '2. 步骤二',
    '',
    '> 引用',
    '',
    '```js',
    'const value = 1',
    '```',
    '',
    '| 名称 | 状态 |',
    '| :--- | ---: |',
    '| 构建 | 通过 |',
  ].join('\n'), document)

  assert.deepEqual(select(fragment, 'h2').map(node => node.textContent), ['项目交接'])
  assert.equal(select(fragment, 'strong').length, 1)
  assert.equal(select(fragment, 'code').map(node => node.textContent).includes('scripts/build.mjs'), true)
  assert.equal(select(fragment, 'ul').length, 2)
  assert.equal(select(fragment, 'ol').length, 1)
  assert.equal(select(fragment, 'blockquote').length, 1)
  const block = select(fragment, 'pre')[0]
  assert.equal(block.className, 'md-block')
  assert.equal(block.textContent, 'const value = 1\n')
  assert.equal(block.children[0].className, 'language-js')
  assert.equal(select(fragment, 'table').length, 1)
  assert.equal(select(fragment, 'th').length, 2)
  assert.equal(select(fragment, 'td')[1].className, 'md-align-right')
  assert.equal(select(fragment, 'p')[0].className, 'md-paragraph')
})

test('markdown preview keeps source text inert and only links safe protocols', () => {
  const fragment = renderMarkdown([
    '<img src=x onerror="alert(1)">',
    '',
    '<div align="center">**居中**</div>',
    '',
    '[safe](https://example.com/a?b=1)',
    '',
    '[unsafe](javascript:alert(1))',
    '',
    '<javascript:alert(2)>',
  ].join('\n'), document)

  assert.deepEqual(select(fragment, 'img'), [])
  assert.deepEqual(select(fragment, 'div'), [])
  assert.deepEqual(select(fragment, 'script'), [])
  const text = textOf(fragment)
  assert.ok(text.includes('<img src=x onerror="alert(1)">'))
  assert.ok(text.includes('居中'))
  const links = select(fragment, 'a')
  assert.deepEqual(links.map(link => link.attributes.href), ['https://example.com/a?b=1'])
  assert.equal(links[0].attributes.rel, 'noopener noreferrer')
  assert.ok(text.includes('unsafe'))
  assert.ok(!text.includes('javascript:alert(1))'))
})

test('markdown preview links bare URLs but not the text around them', () => {
  const fragment = renderMarkdown('见 https://example.com/docs 与 https://example.com/a。', document)
  const links = select(fragment, 'a')
  assert.deepEqual(links.map(link => link.attributes.href), ['https://example.com/docs', 'https://example.com/a'])
  assert.equal(textOf(fragment), '见 https://example.com/docs 与 https://example.com/a。')
})

test('markdown preview survives unclosed fences, stray markers, and long lines', () => {
  const long = 'x'.repeat(20_000)
  const fragment = renderMarkdown([
    '```',
    'never closed',
    '',
    '**unclosed bold and `unclosed code',
    long,
  ].join('\n'), document)
  const blocks = select(fragment, 'pre')
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].textContent.includes('never closed'))
  assert.ok(blocks[0].textContent.includes(long))
  assert.deepEqual(select(fragment, 'script'), [])
})

test('markdown parser ignores inline markers inside fenced code', () => {
  const [block] = parseMarkdown('```md\n# not a heading\n**not bold**\n```')
  assert.equal(block.type, 'fence')
  assert.equal(block.info, 'md')
  assert.equal(block.content, '# not a heading\n**not bold**\n')
})

test('preview preserves a C# heading and all blank lines in a language fence', () => {
  const fragment = renderMarkdown('# C#\n\n```csharp\nfirst\n\n\nlast\n```', document)
  assert.equal(select(fragment, 'h2')[0].textContent, 'C#')
  assert.equal(select(fragment, 'pre')[0].textContent, 'first\n\n\nlast\n')
  assert.equal(select(fragment, 'pre')[0].children[0].className, 'language-csharp')
})

test('only Markdown link tokens can become project file references', () => {
  const source = [
    '[设计][design]', '', '[design]: <../设计%20%231%20(50%25).md>', '',
    '[网站](https://example.com)', '', '```md', '[不是链接](../../ignore.md)', '```',
    '', '![图片](./diagram.png)',
  ].join('\n')
  assert.deepEqual(relativeMarkdownLinks(source), ['../%E8%AE%BE%E8%AE%A1%20%231%20(50%25).md'])
})

test('deeply nested quotes degrade to plain paragraphs instead of overflowing the stack', () => {
  const source = `${'>'.repeat(9000)} deep`
  assert.ok(source.length < 96 * 1024)
  const fragment = renderMarkdown(source, document)
  assert.ok(textOf(fragment).includes('deep'))
  assert.equal(select(fragment, 'script').length, 0)
  // Nested lists and emphasis share the same ceiling.
  const list = renderMarkdown(`${Array.from({ length: 3000 }, (_, index) => `${'  '.repeat(index)}- item`).join('\n')}`, document)
  assert.ok(textOf(list).includes('item'))
})

test('the markdown renderer never assembles HTML strings', async () => {
  const source = await readFile(new URL('../web/markdown.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
})
