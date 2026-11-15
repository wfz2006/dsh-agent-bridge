import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeProjectContext } from '../web/project-context.js'

test('defaults include project context only, even when global files look relevant', () => {
  const { entries, suggestedIds } = describeProjectContext({
    memories: [
      { id: 'global-progress', name: 'current-state', agent: 'codex', scope: 'agent', detail: '智能体记忆' },
      { id: 'project-progress', name: 'current-state', agent: 'shared', scope: 'project', detail: '项目共享记忆' },
      { id: 'hub-note', name: 'decision', agent: 'workspacehub', scope: 'shared', detail: 'P001 · 决策' },
      { id: 'global-guide', name: 'AGENTS', agent: 'codex', scope: 'agent', detail: '用户指引' },
      { id: 'project-guide', name: 'AGENTS', agent: 'shared', scope: 'project', detail: '项目指引' },
    ],
    skills: [
      { id: 'shared-skill', name: 'browser-check', agent: 'shared', scope: 'shared', used: true },
      { id: 'project-skill', name: 'browser-check', agent: 'codex', scope: 'project', used: true },
      { id: 'project-available', name: 'database-check', agent: 'codex', scope: 'project', used: false },
    ],
  })
  assert.deepEqual(suggestedIds, ['project-progress', 'project-skill'])
  assert.deepEqual(Object.fromEntries(entries.map(({ id, global, group }) => [id, [global, group]])), {
    'global-progress': [true, 'notes'],
    'project-progress': [false, 'progress'],
    'hub-note': [false, 'notes'],
    'global-guide': [true, 'guides'],
    'project-guide': [false, 'guides'],
    'shared-skill': [true, 'skills'],
    'project-skill': [false, 'used'],
    'project-available': [false, 'skills'],
  })
})

test('offers a single project handoff but leaves ambiguous or exported notes for review', () => {
  const first = { id: 'first', name: 'handoff-a', agent: 'shared', scope: 'project', detail: '项目交接' }
  const second = { ...first, id: 'second', name: 'handoff-b' }
  const external = { id: 'external', name: 'latest-handoff', agent: 'export', scope: 'project', detail: '配置的记忆导出' }
  assert.deepEqual(describeProjectContext({ memories: [first, external], skills: [] }).suggestedIds, ['first'])
  assert.deepEqual(describeProjectContext({ memories: [first, second, external], skills: [] }).suggestedIds, [])
})
