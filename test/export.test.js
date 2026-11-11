import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeExport } from '../src/export.js'

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
