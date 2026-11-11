import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { readProjectHistory, scanProjects } from '../src/projects.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-agent-projects-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cwd = path.join(root, '开发 项目');
  await mkdir(cwd);
  return { root, cwd };
}

async function writeJsonl(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('WorkspaceHub retains the project ID and native Claude reads only matching project dialogue', async t => {
  const { root, cwd } = await fixture(t);
  const hub = path.join(root, 'workspacehub');
  const record = path.join(hub, '项目档案', 'P123', 'project.yaml');
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, `id: P123\nname: '开发 项目'\ncanonicalPath: ${JSON.stringify(cwd)}\nroots:\n    - id: primary\n      role: primary\n      path: ${JSON.stringify(cwd)}\nagentIDs:\n    - claude\n`);

  const claude = path.join(root, '.claude');
  const file = path.join(claude, 'projects', 'workspace', 'source.jsonl');
  await writeJsonl(file, [
    { type: 'user', cwd, message: { content: 'Fix checkout' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', text: 'Hidden reasoning' }, { type: 'tool_use', name: 'Skill', input: { skill: 'diagnose' } }, { type: 'text', text: 'Checkout fixed' }] } },
    { type: 'user', isMeta: true, message: { content: 'Internal event' } },
  ]);

  const config = { workspaceHubRoots: [hub], agentRoots: { claude: [claude] } };
  const { projects } = await scanProjects(config);
  assert.equal(projects.find(project => project.projectId === 'P123')?.name, '开发 项目');
  const source = projects.find(project => project.archive?.kind === 'claude');
  assert.deepEqual(await readProjectHistory(source, config), {
    messages: [{ role: 'user', text: 'Fix checkout', agent: 'claude' }, { role: 'assistant', text: 'Checkout fixed', agent: 'claude' }],
    usedSkills: ['diagnose'],
  });
  assert.deepEqual(await readProjectHistory({ ...source, cwd: root }, config), { messages: [], usedSkills: [] });

  const outside = path.join(root, 'other.jsonl');
  await writeJsonl(outside, [{ type: 'user', cwd, message: { content: 'Outside source' } }]);
  assert.deepEqual(await readProjectHistory({ ...source, archive: { ...source.archive, file: outside } }, config), { messages: [], usedSkills: [] });
});

test('AgentsView and OpenCode v2 databases retain source bytes and return relevant context', async t => {
  const { root, cwd } = await fixture(t);
  const archive = path.join(root, 'sessions.db');
  const db = new DatabaseSync(archive);
  db.exec(`
    CREATE TABLE sessions (id TEXT, cwd TEXT, agent TEXT, ended_at TEXT, deleted_at TEXT);
    CREATE TABLE messages (session_id TEXT, ordinal INTEGER, role TEXT, dialogue_text TEXT, is_system INTEGER);
    CREATE TABLE tool_calls (session_id TEXT, skill_name TEXT);
    INSERT INTO messages VALUES ('one', 0, 'user', 'Workspace question', 0), ('one', 1, 'assistant', 'Workspace answer', 0), ('one', 2, 'user', 'System metadata', 1);
    INSERT INTO tool_calls VALUES ('one', 'using-git-worktrees');
  `);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, NULL)').run('one', cwd, 'other-agent', '2026-11-03T00:00:00Z');
  db.close();

  const opencode = path.join(root, 'opencode');
  await mkdir(opencode);
  const opencodeFile = path.join(opencode, 'opencode.db');
  const opendb = new DatabaseSync(opencodeFile);
  opendb.exec(`
    CREATE TABLE session_v2 (id TEXT, directory TEXT, time_updated INTEGER);
    CREATE TABLE session_message (session_id TEXT, type TEXT, data TEXT, seq INTEGER);
  `);
  opendb.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)').run('two', cwd, 1794009600000);
  const insert = opendb.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)');
  insert.run('two', 'user', JSON.stringify({ text: 'OpenCode question' }), 0);
  insert.run('two', 'assistant', JSON.stringify({ content: [
    { type: 'reasoning', text: 'Hidden reasoning' },
    { type: 'tool', tool: 'skill', state: { input: { name: 'review' } } },
    { type: 'text', text: 'OpenCode answer' },
  ] }), 1);
  opendb.close();

  const before = await Promise.all([readFile(archive), readFile(opencodeFile)]);
  const config = { archiveFiles: [archive], agentRoots: { opencode: [opencode] } };
  const { projects } = await scanProjects(config);
  const archives = projects.map(project => project.archive).filter(Boolean);
  assert.deepEqual(await readProjectHistory({ cwd: projects[0].cwd, archives }, config), {
    messages: [
      { role: 'user', text: 'Workspace question', agent: 'other-agent' }, { role: 'assistant', text: 'Workspace answer', agent: 'other-agent' },
      { role: 'user', text: 'OpenCode question', agent: 'opencode' }, { role: 'assistant', text: 'OpenCode answer', agent: 'opencode' },
    ],
    usedSkills: ['review', 'using-git-worktrees'],
  });
  assert.deepEqual(await Promise.all([readFile(archive), readFile(opencodeFile)]), before);
});

test('VS Code history reconstructs workspace requests and ignores foreign record paths', async t => {
  const { root, cwd } = await fixture(t);
  const editor = path.join(root, 'Code - Insiders');
  const storage = path.join(editor, 'User', 'workspaceStorage');
  const workspace = path.join(storage, 'hash');
  const file = path.join(workspace, 'chatSessions', 'chat.jsonl');
  await writeJsonl(file, [
    { kind: 0, v: { requests: [] } },
    { kind: 2, k: ['requests'], v: [{ message: { text: 'Build the bridge' }, response: [] }] },
    { kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'Bridge built' }] },
    { kind: 1, k: ['requests', '__proto__', 'tainted'], v: true },
  ]);
  await writeFile(path.join(workspace, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(cwd).href }));
  const config = { agentRoots: { 'vscode-insiders': [editor, storage] } };
  const { projects } = await scanProjects(config);
  const project = projects.find(item => item.archive?.kind === 'copilot');
  assert.equal(projects.filter(item => item.archive?.kind === 'copilot').length, 1);
  assert.deepEqual(await readProjectHistory(project, config), {
    messages: [{ role: 'user', text: 'Build the bridge', agent: 'copilot' }, { role: 'assistant', text: 'Bridge built', agent: 'copilot' }],
    usedSkills: [],
  });
  assert.equal(Object.prototype.tainted, undefined);
});

test('portable sources work without a manager and explicit empty roots disable discovery', async t => {
  const { root, cwd } = await fixture(t);
  const codexSessions = path.join(root, '.codex', 'sessions');
  await writeJsonl(path.join(codexSessions, 'rollout.jsonl'), [
    { type: 'session_meta', payload: { cwd } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue the work' }] } },
  ]);

  const dbPath = path.join(root, 'custom-opencode-store');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session_v2 (id TEXT, directory TEXT, time_updated INTEGER); CREATE TABLE session_message (session_id TEXT, type TEXT, data TEXT, seq INTEGER)');
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)').run('portable', cwd, 1_794_009_600_000);
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)').run('portable', 'user', '{"text":"Read from custom store"}', 0);
  db.close();

  const config = { home: root, agentRoots: { codex: [], opencode: [dbPath] }, projectRoots: [cwd] };
  const { projects, sources } = await scanProjects(config);
  assert.equal(sources.find(source => source.id === 'workspacehub').status, 'unavailable');
  assert.equal(sources.find(source => source.id === 'codex').status, 'unavailable');
  assert.equal(sources.find(source => source.id === 'opencode').status, 'ready');
  assert.deepEqual(projects.map(project => project.agent).sort(), ['manual', 'opencode']);
  assert.deepEqual((await readProjectHistory(projects.find(project => project.agent === 'opencode'), config)).messages,
    [{ role: 'user', text: 'Read from custom store', agent: 'opencode' }]);

  const directConfig = { agentRoots: { 'codex-cli': [codexSessions] } };
  const direct = (await scanProjects(directConfig)).projects[0];
  assert.deepEqual((await readProjectHistory(direct, directConfig)).messages,
    [{ role: 'user', text: 'Continue the work', agent: 'codex' }]);
});
