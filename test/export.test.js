import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeExport } from '../src/export.js'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseMarkdown, relativeMarkdownLinks } from '../web/markdown.js'

test('exports the reviewed context as readable Markdown with a safe portable filename', () => {
  const result = makeExport({
    title: 'a/b\\测试:项目\n标题',
    prompt: '当前分支和下一步\n\n## Skill\n待执行的步骤',
    origin: '项目交接',
    date: new Date('2026-11-11T10:10:03Z'),
  })
  assert.match(result.filename, /^handoff-.+-20261111T101003Z\.md$/)
  assert.doesNotMatch(result.filename, /[\\/:\r\n]/)
  assert.match(result.markdown, /# a\/b\\测试:项目 标题/)
  assert.match(result.markdown, /## Skill\n待执行的步骤/)
  assert.match(result.markdown, /2026-11-11T10:10:03/)
})

test('an incomplete source is marked in the exported handoff', () => {
  const result = makeExport({ title: 'Demo', prompt: 'excerpt', origin: 'DSH 会话', truncated: true })
  assert.match(result.markdown, /来源：DSH 会话/)
  assert.match(result.markdown, /部分内容已截取/)
})

test('handoff and session exports preserve a C# fence byte for byte', () => {
  const fence = '```csharp\r\nfirst();\r\n\r\n\r\nlast();\r\n```'
  const text = `# C#\r\n\r\n${fence}`
  for (const origin of ['项目交接', 'DSH 会话']) {
    const { markdown } = makeExport({
      title: 'Demo', origin,
      preview: { sections: [{ label: '助理', text, conversation: origin === 'DSH 会话', markdown: true }] },
    })
    assert.ok(markdown.includes(`# C#\r\n\r\n${fence}`), markdown)
  }
})

const preview = {
  intro: '请在当前工作区接续。',
  cwd: 'D:\\Demo #1 (50%)\\项目',
  sources: ['Codex', 'Claude Code'],
  sections: [
    { label: '项目约定 · AGENTS.md', file: 'D:\\Demo #1 (50%)\\项目\\AGENTS.md', text: '使用 pnpm。' },
    { label: '近期会话 · 用户', text: '# 这不是标题\n先确认哪一项还没做完。', conversation: true },
    { label: '近期会话 · 助手', text: '已完成。', conversation: true },
  ],
}

test('local export renders headings, an index of clickable file links, and the conversation', () => {
  const { markdown } = makeExport({
    title: '示例项目', origin: '项目交接', preview, date: new Date('2026-11-17T02:03:04Z'),
  })
  assert.match(markdown, /^# 示例项目 · 开发交接$/m)
  assert.match(markdown, /^> 来源：Codex、Claude Code · 2026-11-17T02:03:04Z · 1 份资料 · 2 段对话$/m)
  assert.match(markdown, /^\*\*工作目录\*\*：\[项目\]\(<file:\/\/\/D:\/Demo%20%231%20\(50%25\)\/%E9%A1%B9%E7%9B%AE\/>\)$/m)
  assert.match(markdown, /^## 资料索引$/m)
  assert.match(markdown, /^- \[AGENTS\.md\]\(<file:\/\/\/D:\/Demo%20%231%20\(50%25\)\/%E9%A1%B9%E7%9B%AE\/AGENTS\.md>\) · 项目约定 · AGENTS\.md$/m)
  assert.match(markdown, /^## 项目约定 · AGENTS\.md$/m)
  assert.match(markdown, /^来源：\[AGENTS\.md\]\(<file:/m)
  assert.match(markdown, /^## 最近对话$/m)
  assert.match(markdown, /^### 用户$/m)
  // A heading inside conversation text must not restructure the document.
  assert.match(markdown, /^\\# 这不是标题$/m)
  assert.doesNotMatch(markdown, /^# 这不是标题$/m)
  assert.match(markdown, /^### 助手$/m)
  assert.doesNotMatch(markdown, /^## 近期会话/m)
})

test('share export omits machine paths and only links files when a save location is known', () => {
  const plain = makeExport({ title: '示例项目', origin: '项目交接', preview, format: 'share' })
  assert.doesNotMatch(plain.markdown, /file:\/\//)
  assert.doesNotMatch(plain.markdown, /D:\\/)
  assert.match(plain.markdown, /^\*\*工作目录\*\*：`项目`$/m)
  assert.match(plain.markdown, /^- `AGENTS\.md` · 项目约定 · AGENTS\.md$/m)

  const saved = makeExport({
    title: '示例项目', origin: '项目交接', preview, format: 'share',
    savePath: 'D:\\Demo #1 (50%)\\项目\\.agent-bridge\\handoffs\\latest.md',
  })
  assert.doesNotMatch(saved.markdown, /D:\\/)
  assert.match(saved.markdown, /^- \[AGENTS\.md\]\(<\.\.\/\.\.\/AGENTS\.md>\) · 项目约定/m)
})

test('handoff rebases only parsed body links and keeps code and web links byte-identical', () => {
  const cwd = path.resolve('sample-rebase')
  const file = path.join(cwd, 'docs', 'note.md')
  const target = path.join(cwd, '设计资料', '设计 #1 (50%).md')
  const href = '../%E8%AE%BE%E8%AE%A1%E8%B5%84%E6%96%99/%E8%AE%BE%E8%AE%A1%20%231%20(50%25).md'
  const inline = `[设计](<${href}>)`
  const web = '[站点](<https://example.com/docs?a=1&amp;b=2> "网页说明")'
  const fence = `\`\`\`md\r\n${inline}\r\n\r\n\r\n\`\`\``
  const text = [
    '> - [设计][plan]', '',
    '| 标题 | 链接 |', '|---|---|', `| 左 \\| 右 | ${inline} |`, '',
    `\`${inline}\` ${inline} ${web}`, '', fence, '',
    '[缺失](./missing.md) · [越界](../../outside.md)', '', `[plan]: <${href}>`,
  ].join('\r\n')
  const draft = { cwd, sections: [{ label: '正文', file, text, references: [
    { href, path: target, verifiedFile: target },
    { href: './missing.md', path: path.join(cwd, 'docs', 'missing.md') },
    { href: '../../outside.md', path: path.resolve(cwd, '../outside.md') },
  ] }] }
  const options = { title: 'Rebase', origin: '项目交接', preview: draft }
  const local = makeExport(options).markdown
  const link = `[设计](<${pathToFileURL(target).href}>)`
  assert.ok(local.includes(`> - ${link}`), local)
  assert.ok(local.includes(`| 左 \\| 右 | ${link} |`), local)
  assert.ok(local.includes(`\`${inline}\` ${link} ${web}`), local)
  assert.ok(local.includes(fence), local)
  assert.ok(local.includes('缺失（`docs/missing.md`） · 越界'), local)

  const share = makeExport({ ...options, format: 'share' }).markdown
  assert.ok(share.includes('设计（`设计资料/设计 #1 (50%).md`）'), share)
  assert.ok(share.includes(fence) && share.includes(web), share)
  assert.doesNotMatch(share, /file:\/\//)
  assert.deepEqual(relativeMarkdownLinks(share), [])
  assert.ok(!share.includes(cwd), share)
  const saved = makeExport({ ...options, format: 'share', savePath: path.join(cwd, 'handoffs', 'out.md') }).markdown
  assert.ok(saved.includes(`> - [设计](<${href}>)`), saved)
  assert.equal(makeExport({ ...options, format: 'share', savePath: 'unknown.md' }).markdown, share)
  assert.deepEqual(draft.sections[0].text, text)
})

test('file URI destinations survive Markdown entity decoding and keep the fragment', () => {
  const cwd = path.resolve('sample-rebase')
  const target = path.join(cwd, 'A&amp;B.md')
  const href = './A%26amp%3BB.md#section'
  const { markdown } = makeExport({ title: 'Rebase', origin: '项目交接', preview: { cwd, sections: [{
    label: '正文', file: path.join(cwd, 'note.md'), text: `[章节](<${href}>)`,
    references: [{ href, path: target, verifiedFile: target }],
  }] } })
  assert.ok(markdown.includes(`/A%26amp;B.md#section>`), markdown)
})

function renderedLinks(source) {
  const links = new Map()
  for (const { children } of parseMarkdown(source)) {
    children?.forEach((token, index) => {
      if (token.type === 'link_open') links.set(children[index + 1].content, token.attrGet('href'))
    })
  }
  return links
}

test('each handoff document resolves a shared reference name to its own file or website', () => {
  const cwd = path.resolve('reference-scopes')
  const target = path.join(cwd, 'docs', '设计 #1 (50%).md')
  const href = '../docs/%E8%AE%BE%E8%AE%A1%20%231%20(50%25).md'
  const fenced = '```md\r\n[guide]: untouched.md\r\n\r\n\r\n[guide]\r\n```'
  const preview = { cwd, sections: [{
    label: '项目资料', file: path.join(cwd, 'notes', 'project.md'),
    text: `[项目设计][guide]\r\n\r\n[旧文件][missing]\r\n\r\n${fenced}\r\n\r\n[guide]: <${href}>\r\n[missing]: ../docs/missing.md`,
    references: [{ href, path: target, verifiedFile: target },
      { href: '../docs/missing.md', path: path.join(cwd, 'docs', 'missing.md') }],
  }, {
    label: '在线手册', file: path.join(cwd, 'notes', 'manual.md'),
    text: '[在线手册][GUIDE]\n\n[guide]: https://example.com/manual "在线说明"',
  }, {
    label: '引用未定义', file: path.join(cwd, 'notes', 'unresolved.md'), text: '[无定义的项目说明][guide]',
  }] }
  for (const format of ['local', 'share']) {
    const { markdown } = makeExport({ title: 'Merged', origin: '项目交接', preview, format })
    const urls = renderedLinks(markdown)
    assert.equal(urls.get('在线手册'), 'https://example.com/manual')
    assert.equal(urls.get('项目设计'), format === 'local' ? pathToFileURL(target).href : undefined)
    assert.ok(markdown.includes('旧文件（`docs/missing.md`）'))
    assert.ok(!urls.has('旧文件') && !urls.has('无定义的项目说明'))
    assert.ok(markdown.includes(fenced))
    if (format === 'share') assert.ok(markdown.includes('项目设计（`docs/设计 #1 (50%).md`）'))
  }
})

test('colliding website reference names preserve both destinations in either export format', () => {
  const cwd = path.resolve('web-reference-scopes')
  const preview = { cwd, sections: [{
    label: '第一个网站', file: path.join(cwd, 'one.md'),
    text: '> [guide][]\n\n[guide]: https://one.example/docs?a=1&amp;b=2 "First"',
  }, {
    label: '第二个网站', file: path.join(cwd, 'two.md'),
    text: '| 入口 |\n| --- |\n| [第二站][Guide] |\n\n[guide]: https://two.example/setup "Second | setup"',
  }] }
  for (const format of ['local', 'share']) {
    const { markdown } = makeExport({ title: 'Web links', origin: '项目交接', preview, format })
    const urls = renderedLinks(markdown)
    assert.equal(urls.get('guide'), 'https://one.example/docs?a=1&b=2')
    assert.equal(urls.get('第二站'), 'https://two.example/setup')
    const secondLink = parseMarkdown(markdown).flatMap(token => token.children ?? [])
      .find(token => token.attrGet('href') === 'https://two.example/setup')
    assert.equal(secondLink.attrGet('title'), 'Second | setup')
  }
})

test('reference images keep their source when nested in a website link', () => {
  const cwd = path.resolve('image-reference-scopes')
  const { markdown } = makeExport({ title: 'Images', origin: '项目交接', preview: { cwd, sections: [{
    label: '图示', file: path.join(cwd, 'one.md'),
    text: '[![示意图][image]][guide]\r\n\r\n> [image]: https://docs.example/diagram.png\r\n> [guide]: https://docs.example/guide',
  }] } })
  const inline = parseMarkdown(markdown).flatMap(token => token.children ?? [])
  assert.ok(inline.some(token => token.type === 'link_open' && token.attrGet('href') === 'https://docs.example/guide'))
  assert.ok(inline.some(token => token.type === 'image' && token.attrGet('src') === 'https://docs.example/diagram.png'))
})

test('empty sections are omitted and an unbalanced fence is closed inside its own section', () => {
  const { markdown } = makeExport({
    title: 'Demo', origin: '项目交接',
    preview: {
      cwd: '', sources: [], sections: [
        { label: '记忆 · 笔记', text: '```\n---\n===\n' },
        { label: '记忆 · 空', text: '' },
        { label: '近期会话 · 用户', text: '问一句', conversation: true },
      ],
    },
  })
  assert.doesNotMatch(markdown, /^## 资料索引$/m)
  assert.match(markdown, /^## 记忆 · 笔记$/m)
  assert.match(markdown, /^## 记忆 · 笔记\n\n```\n---\n===\n```$/m)
  assert.doesNotMatch(markdown, /^## 记忆 · 空$/m)
  assert.match(markdown, /^## 最近对话$/m)
  assert.doesNotMatch(markdown, /^\*\*工作目录\*\*/m)
})

test('an explicitly requested trace section lists records without raw parameters by default', () => {
  const trace = [
    { kind: 'summary', text: '先核对磁盘现场。', status: 'ok' },
    { kind: 'tool_call', name: 'shell', text: 'pnpm test', status: 'ok' },
    { kind: 'tool_result', name: 'shell', text: '80 passing', status: 'ok' },
    { kind: 'tool_result', name: 'read', text: '', status: 'missing' },
  ]
  const withTrace = makeExport({
    title: 'Demo', origin: '项目交接', preview: { ...preview, trace }, includeTrace: true,
  })
  assert.match(withTrace.markdown, /^## 来源记录$/m)
  assert.match(withTrace.markdown, /^- 思考摘要 · 先核对磁盘现场。$/m)
  assert.match(withTrace.markdown, /^- 工具调用 · `shell` · 已完成$/m)
  assert.match(withTrace.markdown, /^- 工具结果 · `read` · 未记录结果$/m)
  assert.match(withTrace.markdown, /不会重放任何工具调用/)

  const without = makeExport({ title: 'Demo', origin: '项目交接', preview: { ...preview, trace } })
  assert.doesNotMatch(without.markdown, /来源记录|80 passing/)
})

test('explicit trace export distinguishes calls to the same tool by turn and source ID', () => {
  const { markdown } = makeExport({
    title: 'Interrupted', origin: 'DSH 会话', includeTrace: true,
    preview: { trace: [
      { kind: 'tool_call', name: 'read', callId: 'call-a', turn: 1, status: 'ok', text: 'private args' },
      { kind: 'tool_result', name: 'read', callId: 'call-a', turn: 1, status: 'ok', text: 'late A' },
      { kind: 'tool_result', name: 'read', callId: 'call-b', turn: 2, status: 'error', text: 'failed B', truncated: true },
    ] },
  })
  const [, first, second] = markdown.split(/^### 第 [12] 轮$/m)
  assert.match(first, /工具结果 · `read` · 调用 `call-a` · 已完成\n  - late A/)
  assert.match(second, /工具结果 · `read` · 调用 `call-b` · 失败 · 已截取\n  - failed B/)
  assert.doesNotMatch(markdown, /private args/)
})
