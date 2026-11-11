import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listProjectAssets, readAsset } from '../src/assets.js';

async function fixture(t) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-assets-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const cwd = path.join(temp, '工作 tree');
  const home = path.join(temp, 'home');
  await mkdir(cwd);
  await mkdir(home);
  return { cwd, home, temp };
}

async function put(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
  return file;
}

test('finds standalone project notes and handoffs with portable configurable roots', async (t) => {
  const { cwd, home, temp } = await fixture(t);
  const state = await put(path.join(cwd, '.agent-bridge', 'memory', 'current-state.md'), 'current task');
  const handoff = await put(path.join(cwd, '.agent-bridge', 'handoffs', 'latest-handoff.md'), 'continue here');
  await put(path.join(cwd, '.agent-bridge', 'memory', 'nested', 'ignore.md'), 'outside indexed folders');
  const elsewhere = path.join(temp, 'other-workspace');
  await put(path.join(elsewhere, '.agent-bridge', 'memory', 'current-state.md'), 'different project');
  const agentRoot = path.join(temp, 'custom-opencode');
  const agentNote = await put(path.join(agentRoot, 'memory', 'notes.md'), 'custom agent data');
  const skillRoot = path.join(temp, 'skillshare');
  const skill = await put(path.join(skillRoot, 'verify', 'SKILL.md'), '# Verify');

  const result = await listProjectAssets({ cwd, agents: ['opencode'], projectIds: [] }, {
    home, agentRoots: { opencode: [agentRoot] }, skillRoots: [skillRoot],
  });
  assert.deepEqual(new Set(result.memories.map(({ file }) => file)), new Set([state, handoff, agentNote]));
  assert.deepEqual(result.skills.map(({ file }) => file), [skill]);
  const item = result.memories.find(({ file }) => file === handoff);
  assert.equal(item.scope, 'project');
  assert.equal(item.detail, '项目交接');
  assert.deepEqual(await readAsset(item), { text: 'continue here', truncated: false });
});

test('keeps OpenCode configuration skills separate from data roots and honors empty overrides', async (t) => {
  const { cwd, home, temp } = await fixture(t);
  const configRoot = path.join(temp, 'xdg', 'opencode');
  const singular = await put(path.join(configRoot, 'skill', 'legacy', 'SKILL.md'), '# Legacy');
  const plural = await put(path.join(configRoot, 'skills', 'current', 'SKILL.md'), '# Current');
  const fallback = await put(path.join(home, '.config', 'opencode', 'skills', 'default', 'SKILL.md'), '# Default');
  await put(path.join(home, '.local', 'share', 'opencode', 'memory', 'default.md'), 'disabled data');
  await put(path.join(home, '.claude', 'CLAUDE.md'), 'disabled agent');
  const project = { cwd, agents: ['OpenCode', 'Claude Code'], projectIds: [] };
  const result = await listProjectAssets(project, {
    home, opencodeSkillRoots: [configRoot], agentRoots: { opencode: [], 'claude-code': [] },
  });
  assert.deepEqual(result.memories, []);
  assert.deepEqual(new Set(result.skills.map(({ file }) => file)), new Set([singular, plural]));
  assert(result.skills.every(({ agent, scope }) => agent === 'opencode' && scope === 'agent'));

  const direct = await listProjectAssets({ ...project, agents: ['opencode'] }, { home });
  assert(direct.skills.some(({ file }) => file === fallback));
});

test('lists scoped notes, linked skill packages and only the matching WorkspaceHub project', async (t) => {
  const { cwd, home, temp } = await fixture(t);
  const sharedRoot = path.join(temp, 'hub');
  const otherHub = path.join(temp, 'other');
  const bucket = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const claudeMemory = await put(path.join(home, '.claude', 'projects', bucket, 'memory', 'MEMORY.md'), '原生记忆');
  await put(path.join(home, '.claude', 'projects', 'other', 'memory', 'MEMORY.md'), 'different project');
  await put(path.join(home, '.claude', 'projects', bucket, 'memory', 'api-key.md'), 'private');
  const record = path.join(sharedRoot, '项目档案', 'P001');
  await put(path.join(record, 'project.yaml'), `canonicalPath: ${JSON.stringify(cwd)}\n`);
  const handoff = await put(path.join(record, '交接', 'state.md'), '交接状态');
  await put(path.join(otherHub, '项目档案', 'P001', 'project.yaml'), `canonicalPath: ${JSON.stringify(temp)}\n`);
  await put(path.join(otherHub, '项目档案', 'P001', '交接', 'state.md'), 'other registry');
  const skill = await put(path.join(home, '.agents', 'skills', 'check', 'SKILL.md'), '# Check');
  await mkdir(path.join(home, '.claude', 'skills'), { recursive: true });
  await symlink(path.dirname(skill), path.join(home, '.claude', 'skills', 'check'), 'junction');
  await put(path.join(cwd, '.unrelated', 'SKILL.md'), 'ignore');

  const result = await listProjectAssets({ cwd, agents: ['Claude Code'], projectIds: ['P001'] }, {
    home,
    workspaceHubRoots: [sharedRoot, otherHub],
  });
  assert.deepEqual(new Set(result.memories.map((item) => item.file)), new Set([claudeMemory, handoff]));
  assert(result.skills.some((item) => item.file === skill && item.agent === 'claude'));
  assert(result.skills.some((item) => item.file === skill && item.scope === 'shared'));
  assert.deepEqual(await readAsset(result.memories.find((item) => item.file === handoff)), {
    text: '交接状态',
    truncated: false,
  });
});

test('reads a UTF-8 prefix and refuses a path replaced by a junction after indexing', async (t) => {
  const { cwd, home, temp } = await fixture(t);
  const note = await put(path.join(cwd, '.claude', 'skills', 'check', 'SKILL.md'), '中'.repeat(60000));
  const { skills } = await listProjectAssets({ cwd, agents: ['claude'], projectIds: [] }, { home });
  const item = skills.find(({ file }) => file === note);
  const prefix = await readAsset(item);
  assert(prefix.truncated);
  assert.match(prefix.text, /^中+$/u);
  assert(prefix.text.length < 60000);

  const outside = path.join(temp, 'outside');
  await put(path.join(outside, 'SKILL.md'), 'escape');
  await rename(path.dirname(note), path.join(path.dirname(path.dirname(note)), 'retained'));
  await symlink(outside, path.dirname(note), 'junction');
  await assert.rejects(readAsset(item), /changed|outside|unavailable|confined/iu);
});

test('uses explicit Markdown exports only for the configured worktree', async (t) => {
  const { cwd, home, temp } = await fixture(t);
  const folder = path.join(temp, 'exports');
  const handoff = await put(path.join(folder, '交接.md'), 'readable export');
  const single = await put(path.join(temp, 'project-notes.md'), 'separate file');
  const other = await put(path.join(temp, 'different.md'), 'other worktree');
  await put(path.join(folder, 'database.json'), '{}');
  await put(path.join(folder, 'nested', 'other.md'), 'outside configured scope');
  const { memories } = await listProjectAssets({ cwd, agents: [], projectIds: [] }, {
    home, memoryExports: { [cwd]: [folder, single], [home]: [other] },
  });
  assert.deepEqual(new Set(memories.map(({ file }) => file)), new Set([handoff, single]));
  assert(memories.every(({ agent, scope }) => agent === 'export' && scope === 'project'));
});
