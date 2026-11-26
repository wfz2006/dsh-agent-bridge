import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findShareFindings, redactShareMarkdown } from '../web/share-redaction.js'

test('finds quoted and unquoted paths across platforms without matching ordinary URLs or relative paths', () => {
  const win = 'C:\\Users\\Example User\\私有项目\\notes.md'
  const escaped = JSON.stringify(win).slice(1, -1)
  const unc = '\\\\dev-box\\Team Share\\notes.txt'
  const fileUri = 'file:///D:/Work%20Space/设计.md#section'
  const unix = '/home/local/Build Logs/report.txt'
  const home = '~/private/note.txt'
  const markdown = [
    'Located at ' + win + '。Next step is unchanged.',
    '{"path":"' + escaped + '"}',
    'Quoted share "' + unc + '"',
    '[文档](<' + fileUri + '>)',
    'Output ' + unix + ', verified.',
    'Open ' + home,
    'See https://example.org/home/local/docs and [相对路径](./docs/guide.md).',
    'Try %USERPROFILE%\\OneDrive\\Drafts\\plan.md and D:/repo/setup.js.',
  ].join('\n')
  const found = findShareFindings(markdown)
  assert.deepEqual(found.map(({ kind, start, end, line }) => [kind, markdown.slice(start, end), line]), [
    ['path', win, 1], ['path', escaped, 2], ['path', unc, 3], ['path', fileUri, 4],
    ['path', unix, 5], ['path', home, 6],
    ['path', '%USERPROFILE%\\OneDrive\\Drafts\\plan.md', 8], ['path', 'D:/repo/setup.js', 8],
  ])
  assert.match(redactShareMarkdown(markdown, found), /https:\/\/example\.org\/home\/local\/docs and \[相对路径\]\(\.\/docs\/guide\.md\)/)
})

test('reviews each occurrence separately and only replaces selected source spans in Markdown', () => {
  const ticks = String.fromCharCode(96).repeat(3)
  const markdown = [
    '## 联系方式', '',
    '邮件 <dev@example.test>。再次使用 dev@example.test。', '',
    '### 工具结果 · 第 3 轮', '',
    ticks + 'txt',
    '  output from 10.0.42.8 and https://[fd00::2]:443',
    '  email=dev@example.test',
    '  contact via mailto:help%40example.test',
    '  SESSION_TOKEN=fixture-only-secret',
    '  password = [已隐藏]',
    '  BAD_VERSION=999.400.300.888',
    ticks, '', '',
  ].join('\r\n')
  const findings = findShareFindings(markdown)
  assert.deepEqual(findings.map(({ kind, line }) => [kind, line]), [
    ['email', 3], ['email', 3], ['ip', 8], ['ip', 8], ['email', 9], ['email', 10], ['credential', 11],
  ])
  const keep = new Set([findings[1].start])
  const output = redactShareMarkdown(markdown, findings, keep)
  assert.equal(output, markdown
    .replace('<dev@example.test>', '<〈邮箱已脱敏〉>')
    .replace('10.0.42.8', '〈IP 已脱敏〉')
    .replace('[fd00::2]', '〈IP 已脱敏〉')
    .replace('email=dev@example.test', 'email=〈邮箱已脱敏〉')
    .replace('help%40example.test', '〈邮箱已脱敏〉')
    .replace('fixture-only-secret', '〈凭据已脱敏〉'))
  assert.equal(redactShareMarkdown(markdown, findings, new Set(findings.map(finding => finding.start))), markdown)
  assert.equal(redactShareMarkdown('nothing to review\r\n\r\n', []), 'nothing to review\r\n\r\n')
})

test('merges overlapping values and does not leak inside a redacted path or credential', () => {
  const markdown = '/home/user@example.test/private.md\npassword="demo@example.test"\nhttps://test.example?access_token=sample%2Fsecret'
  const findings = findShareFindings(markdown)
  assert.deepEqual(findings.map(({ kind }) => kind), ['path', 'credential', 'credential'])
  assert.equal(redactShareMarkdown(markdown, findings), [
    '〈本机路径已脱敏〉', 'password="〈凭据已脱敏〉"', 'https://test.example?access_token=〈凭据已脱敏〉',
  ].join('\n'))
})

test('keeps nearby prose and reviews independent paths on the same line', () => {
  const windows = 'D:/build/cache.log'
  const unix = '/private/tmp/build.log'
  const extended = '\\\\?\\D:\\build\\private path.txt'
  const markdown = 'Copy ' + windows + ' to ' + unix + ' and read README.md\nOpen ' + extended
  const findings = findShareFindings(markdown)
  assert.deepEqual(findings.map(({ start, end }) => markdown.slice(start, end)), [windows, unix, extended])
  assert.match(redactShareMarkdown(markdown, findings), / and read README\.md\n/)
})
