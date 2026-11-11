import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeProjects, makePrompt, redact } from '../src/catalog.js'

test('keeps worktrees distinct and merges agent associations case-insensitively on Windows', () => {
  const projects = mergeProjects([
    { cwd: 'D:\\Dev\\Demo', agent: 'codex' },
    { cwd: 'd:/dev/demo', agent: 'claude', projectId: 'P001', name: 'Demo project' },
    { cwd: 'D:\\Dev\\Demo-Fix', agent: 'codex' },
  ], 'win32')
  assert.equal(projects.length, 2)
  assert.deepEqual(projects[0].agents, ['claude', 'codex'])
  assert.deepEqual(projects[0].projectIds, ['P001'])
})

test('a handoff preserves context provenance and masks recognizable credentials', () => {
  const { prompt } = makePrompt({ name: 'Demo', cwd: 'D:/dev/demo', agents: ['codex'] }, [
    { label: '记忆 · 当前状态', file: 'D:/memory/当前状态.md', text: 'pending work' },
    { label: '会话 · user', text: 'api_key = secret-test-value' },
  ], '')
  assert.match(prompt, /D:\/dev\/demo/)
  assert.match(prompt, /D:\/memory\/当前状态\.md/)
  assert.match(prompt, /pending work/)
  assert.doesNotMatch(prompt, /secret-test-value/)
  assert.doesNotMatch(redact('Authorization: Bearer abc123'), /abc123/)
})

test('large history cannot starve a selected memory or overflow the handoff budget', () => {
  const { prompt, truncated } = makePrompt({ name: 'Demo', cwd: 'D:/dev/demo', agents: [] }, [
    { label: '记忆', text: 'memory-marker' },
    ...Array.from({ length: 20 }, () => ({ label: '会话', text: 'x'.repeat(5000) })),
  ], '')
  assert.ok(prompt.length <= 32_000)
  assert.match(prompt, /memory-marker/)
  assert.equal(truncated, true)
})

test('a reimported portable handoff can use the full context budget', () => {
  const { prompt, truncated } = makePrompt({ name: 'Demo', cwd: 'D:/dev/demo', agents: [] }, [
    { label: '项目交接', handoff: true, text: 'x'.repeat(10_000) + '\nnext-step-marker' },
  ], '')
  assert.match(prompt, /next-step-marker/)
  assert.equal(truncated, false)
})

test('a reimported Markdown heading stays inside its original preview section', () => {
  const { prompt, preview } = makePrompt({ name: 'Demo', cwd: 'D:/dev/demo', agents: [] }, [
    { label: '记忆 · 导出的交接', text: '已有正文\n\n## Skill · 嵌套标题\n原文', handoff: true },
    { label: '近期会话 · 用户', text: '接续请求' },
  ], '')
  assert.equal(preview.sections.length, 2)
  assert.match(preview.sections[0].text, /## Skill · 嵌套标题/)
  assert.ok(prompt.includes(preview.sections[0].text))
})
