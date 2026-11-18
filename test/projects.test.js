import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { readConversationHistory, readProjectHistory, scanProjects } from '../src/projects.js';

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

const zstdOptions = { skip: !zlib.createZstdCompress && 'This Node version does not provide Zstandard' };
const codexRow = (role, ...blocks) => ({
  type: 'response_item',
  payload: { type: 'message', role, content: blocks.map(text => ({ type: role === 'user' ? 'input_text' : 'output_text', text })) },
});
const codexMeta = (cwd, id) => ({ type: 'session_meta', payload: { id, cwd } });
const jsonl = row => JSON.stringify(row) + '\n';

async function writeZstd(file, chunks) {
  await mkdir(path.dirname(file), { recursive: true });
  await pipeline(Readable.from(chunks), zlib.createZstdCompress(), createWriteStream(file));
}

function codexIndex(root, records) {
  const database = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  try {
    database.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, title TEXT)');
    const insert = database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)');
    for (const record of records) insert.run(...record);
  } finally {
    database.close();
  }
}

const dialogue = result => result.messages.map(({ role, text }) => [role, text]);

test('Codex finds compressed sessions and archives without a SQLite index', zstdOptions, async t => {
  const { root, cwd } = await fixture(t);
  const paths = [
    path.join(root, 'sessions', '2026', '11', '15', 'recent.jsonl.zst'),
    path.join(root, 'archived_sessions', 'archived.jsonl.zst'),
  ];
  for (const [index, file] of paths.entries()) {
    await writeZstd(file, [codexMeta(cwd, 'thread-' + index), codexRow('user', 'Continue chat ' + index),
      codexRow('assistant', 'Previous answer')].map(jsonl));
  }
  const config = { agentRoots: { codex: [root] } };
  const { projects } = await scanProjects(config);
  assert.equal(projects.length, 2);
  for (const [index, file] of paths.entries()) {
    const project = projects.find(item => item.archive?.file === file);
    assert.equal(project?.archive?.title, 'Continue chat ' + index);
    assert.deepEqual(dialogue(await readConversationHistory(project.archive, cwd, config)), [
      ['user', 'Continue chat ' + index], ['assistant', 'Previous answer'],
    ]);
  }
});

test('Codex uses the compressed replacement of a stale index path and includes compressed files missing from the index', zstdOptions, async t => {
  const { root, cwd } = await fixture(t);
  const stale = path.join(root, 'sessions', '2026', '11', '15', 'compressed-in-place.jsonl');
  const indexed = path.join(root, 'archived_sessions', 'indexed.jsonl.zst');
  const unindexed = path.join(root, 'archived_sessions', 'unindexed.jsonl.zst');
  for (const [id, file] of [['one', stale + '.zst'], ['two', indexed], ['three', unindexed]]) {
    await writeZstd(file, [codexMeta(cwd, id), codexRow('user', 'Question ' + id)].map(jsonl));
  }
  codexIndex(root, [
    ['one', cwd, stale, 1_794_009_600, 'Indexed title'],
    ['two', cwd, indexed, 1_794_009_601, 'Indexed archive'],
    ['missing', cwd, path.join(root, 'archived_sessions', 'missing.jsonl.zst'), 1_794_009_602, 'Unavailable'],
  ]);
  const config = { agentRoots: { codex: [root] } };
  const { projects } = await scanProjects(config);
  const archives = projects.map(item => item.archive).filter(Boolean);
  assert.deepEqual(archives.map(item => [item.file, item.title]).sort(), [
    [stale + '.zst', 'Indexed title'], [indexed, 'Indexed archive'], [unindexed, 'Question three'],
  ].sort());
  const transcript = await readConversationHistory(archives.find(item => item.title === 'Indexed title'), cwd, config);
  assert.deepEqual(dialogue(transcript), [['user', 'Question one']]);
});

test('Codex streams compressed transcripts beyond 32 MiB without letting tool output displace dialogue', zstdOptions, async t => {
  const { root, cwd } = await fixture(t);
  const file = path.join(root, 'sessions', 'large.jsonl.zst');
  const filler = jsonl({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(1024 * 1024) } });
  function* transcript() {
    yield jsonl(codexMeta(cwd, 'large'));
    for (let i = 0; i < 12; i++) yield jsonl(codexRow('user', 'Earlier question ' + 'x'.repeat(23_990)));
    yield jsonl(codexRow('user', '继续检查新版本 🧪'));
    for (let i = 0; i < 36; i++) yield filler;
    yield JSON.stringify(codexRow('assistant', '最新结果已记录。'));
  }
  await writeZstd(file, transcript());
  codexIndex(root, [['large', cwd, file, 1_794_009_600, 'Long conversation']]);
  const config = { agentRoots: { codex: [root] } };
  const { projects } = await scanProjects(config);
  const result = await readConversationHistory(projects[0].archive, cwd, config);
  assert.equal(result.truncated, true);
  assert.equal(result.sourceStats.partial, true);
  assert.deepEqual(dialogue(result).slice(-2), [['user', '继续检查新版本 🧪'], ['assistant', '最新结果已记录。']]);
  assert.deepEqual(dialogue(await readConversationHistory(projects[0].archive, root, config)), []);
});

test('a long Codex answer sequence retains the real question and most recent answer for import', zstdOptions, async t => {
  const { root, cwd } = await fixture(t);
  const file = path.join(root, 'sessions', 'many-answers.jsonl.zst');
  await writeZstd(file, [codexMeta(cwd, 'many-answers'), codexRow('user', '我上次的问题'),
    ...Array.from({ length: 8 }, () => codexRow('assistant', 'x'.repeat(24_000))),
    codexRow('assistant', '最后的回复。')].map(jsonl));
  const config = { agentRoots: { codex: [root] } };
  const { projects } = await scanProjects(config);
  const result = await readConversationHistory(projects[0].archive, cwd, config);
  assert.equal(result.truncated, true);
  assert.deepEqual(dialogue(result).at(0), ['user', '我上次的问题']);
  assert.deepEqual(dialogue(result).at(-1), ['assistant', '最后的回复。']);
  assert.ok(result.messages.reduce((sum, row) => sum + row.text.length, 0) <= 160_000);
});

test('Codex keeps user text after a runtime wrapper, including when both are in one text block', async t => {
  const { root, cwd } = await fixture(t);
  const file = path.join(root, 'sessions', 'mixed.jsonl');
  const environment = '<environment_context>private local metadata</environment_context>';
  await writeJsonl(file, [
    codexMeta(cwd, 'mixed'),
    codexRow('user', environment),
    codexRow('user', environment, '请继续排查导入'),
    codexRow('assistant', '已查到一个原因'),
    codexRow('user', environment + '\n<permissions instructions>runtime flags</permissions instructions>\n把这个原因修好',
      '<collaboration_mode>runtime mode</collaboration_mode>', '并补上测试'),
    codexRow('user', '什么是 <environment_context>？'),
  ]);
  const config = { agentRoots: { codex: [root] } };
  const { projects } = await scanProjects(config);
  assert.equal(projects[0].archive.title, '请继续排查导入');
  const expected = [['user', '请继续排查导入'], ['assistant', '已查到一个原因'],
    ['user', '把这个原因修好\n并补上测试'], ['user', '什么是 <environment_context>？']];
  assert.deepEqual(dialogue(await readConversationHistory(projects[0].archive, cwd, config)), expected);
  assert.deepEqual(dialogue(await readProjectHistory(projects[0], config)), expected);
});

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
    { kind: 2, k: ['requests'], v: [{ message: { text: 'Build the bridge' }, response: [], timestamp: 1_794_009_600_000 }] },
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
  const history = await readConversationHistory(project.archive, cwd, config);
  assert.deepEqual(history.sourceStats, { userMessages: 1, assistantMessages: 1, importedMessages: 2, partial: false });
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

const codexTraceRow = (payload, timestamp) => ({ type: 'response_item', ...(timestamp ? { timestamp } : {}), payload });

test('interrupted and late Codex results follow their call across user turns', async t => {
  const { root, cwd } = await fixture(t);
  await writeJsonl(path.join(root, 'sessions', 'interruption.jsonl'), [
    codexMeta(cwd, 'interruption'),
    codexRow('user', 'Question A'),
    codexRow('assistant', 'Checking A'),
    codexTraceRow({ type: 'reasoning', id: 'summary-a', summary: [{ type: 'summary_text', text: 'A only' }] }),
    codexTraceRow({ type: 'function_call', name: 'list', call_id: 'call-a1' }),
    codexTraceRow({ type: 'function_call', name: 'read', call_id: 'call-a2' }),
    codexTraceRow({ type: 'function_call_output', call_id: 'call-a2', output: 'A2' }),
    codexRow('user', 'Question B'),
    codexTraceRow({ type: 'function_call_output', call_id: 'call-a1', output: 'A1 late' }),
    codexTraceRow({ type: 'function_call_output', call_id: 'call-b', output: 'B before call' }),
    codexTraceRow({ type: 'function_call', name: 'check', call_id: 'call-b' }),
    codexRow('assistant', 'Answer B'),
  ]);
  const config = { agentRoots: { codex: [root] } };
  const { projects } = await scanProjects(config);
  const { trace, messages } = await readConversationHistory(projects[0].archive, cwd, config);
  assert.deepEqual(trace.filter(item => item.kind === 'tool_result').map(item => [
    item.callId, item.name, item.turn, messages[item.messageIndex].text,
  ]), [
    ['call-a2', 'read', 1, 'Checking A'], ['call-a1', 'list', 1, 'Checking A'],
    ['call-b', 'check', 2, 'Answer B'],
  ]);
  assert.equal(trace.find(item => item.kind === 'summary').turn, 1);
});

test('Codex source records pair parallel tool calls, keep visible summaries, and never invent results', async t => {
  const { root, cwd } = await fixture(t);
  const file = path.join(root, 'sessions', 'trace.jsonl');
  await writeJsonl(file, [
    codexMeta(cwd, 'trace'),
    codexRow('user', 'Audit the build'),
    codexTraceRow({
      type: 'reasoning', id: 'reason-1',
      summary: [{ type: 'summary_text', text: 'Checked the workspace first.' }, { type: 'encrypted_content', text: 'ciphertext-marker' }],
    }, '2026-11-17T00:00:01Z'),
    codexTraceRow({ type: 'function_call', name: 'shell', call_id: 'call-a', arguments: '{"cmd":"npm test"}' }, '2026-11-17T00:00:02Z'),
    codexTraceRow({ type: 'function_call', name: 'read_file', call_id: 'call-b', arguments: '{"path":"AGENTS.md"}' }, '2026-11-17T00:00:03Z'),
    codexTraceRow({ type: 'function_call_output', call_id: 'call-a', output: 'exit code: 1\n2 tests failed' }),
    codexTraceRow({ type: 'function_call_output', call_id: 'call-b', output: 'exit code: 0\n' + 'x'.repeat(9_000) }),
    codexRow('assistant', 'The build is broken.'),
    codexRow('user', 'Audit the build'),
    codexRow('assistant', 'The build is broken.'),
    codexTraceRow({ type: 'custom_tool_call', name: 'grep', call_id: 'call-c', input: '{"pattern":"TODO"}' }),
    codexRow('assistant', 'Found nothing else.'),
  ]);
  const config = { agentRoots: { codex: [root] } };
  const { projects } = await scanProjects(config);
  const result = await readConversationHistory(projects[0].archive, cwd, config);

  assert.deepEqual(dialogue(result), [
    ['user', 'Audit the build'], ['assistant', 'The build is broken.'],
    ['user', 'Audit the build'], ['assistant', 'The build is broken.'], ['assistant', 'Found nothing else.'],
  ]);
  const byId = new Map(result.trace.map(item => [item.id, item]));
  assert.equal(byId.get('summary-reason-1').text, 'Checked the workspace first.');
  assert.equal(result.trace.some(item => item.text.includes('ciphertext-marker')), false);
  assert.equal(byId.get('tool_call-call-a').status, 'error');
  assert.equal(byId.get('tool_result-call-a').status, 'error');
  assert.equal(byId.get('tool_call-call-b').status, 'ok');
  assert.equal(byId.get('tool_result-call-b').truncated, true);
  assert.ok(byId.get('tool_result-call-b').text.length <= 8_000);
  assert.equal(byId.get('tool_call-call-c').status, 'missing');
  assert.equal(byId.get('tool_call-call-c').name, 'grep');
  assert.equal(result.trace.filter(item => item.kind === 'tool_call').length, 3);
  assert.equal(result.trace.filter(item => item.kind === 'summary').length, 1);
  for (const message of result.messages) {
    for (const id of message.traceIds ?? []) assert.ok(byId.has(id), `unknown trace id ${id}`);
  }
  const assistant = result.messages.find(message => message.text === 'The build is broken.');
  assert.deepEqual(assistant.traceIds.sort(),
    ['summary-reason-1', 'tool_call-call-a', 'tool_call-call-b', 'tool_result-call-a', 'tool_result-call-b'].sort());
});

test('source statistics count readable messages before the migration limit and use the latest Codex token total', async t => {
  const { root, cwd } = await fixture(t);
  const file = path.join(root, 'sessions', 'statistics.jsonl');
  const firstAt = Date.parse('2026-11-18T00:00:00Z');
  const messages = Array.from({ length: 602 }, (_, i) => ({
    ...codexRow(i % 2 ? 'assistant' : 'user', `Message ${i + 1}`),
    timestamp: new Date(firstAt + i * 1000).toISOString(),
  }));
  const usage = (input, output) => ({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
    last_token_usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
  } } });
  await writeJsonl(file, [codexMeta(cwd, 'statistics'), usage(400, 100), ...messages,
    usage(1300, 500), usage(1300, 500), { type: 'event_msg', payload: { type: 'token_count', info: null } }]);
  const config = { agentRoots: { codex: [root] } };
  const history = await readConversationHistory({ kind: 'codex', file }, cwd, config);
  assert.equal(history.messages.length, 600);
  assert.equal(history.truncated, true);
  assert.deepEqual(history.sourceStats, {
    userMessages: 301, assistantMessages: 301, importedMessages: 600, partial: false, elapsedMs: 601_000,
    tokens: { total: 1800, input: 1300, output: 500 },
  });
});

test('compressed Codex transcripts keep the same source record as plain JSONL', zstdOptions, async t => {
  const { root, cwd } = await fixture(t);
  const file = path.join(root, 'sessions', 'trace.jsonl.zst');
  const rows = [
    codexMeta(cwd, 'trace'),
    codexRow('user', 'Check the release'),
    codexTraceRow({ type: 'reasoning', id: 'reason-9', summary: [{ type: 'summary_text', text: 'Reviewed the changelog.' }] }),
    codexTraceRow({ type: 'function_call', name: 'shell', call_id: 'call-z', arguments: '{"cmd":"npm pack"}' }),
    codexTraceRow({ type: 'function_call_output', call_id: 'call-z', output: 'package.tgz' }),
    codexRow('assistant', 'Packaging works.'),
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 22 } } } },
  ];
  await writeZstd(file, rows.map(jsonl));
  codexIndex(root, [['trace', cwd, file, 1_794_009_600, 'Check the release']]);
  const config = { agentRoots: { codex: [root] } };
  const { projects } = await scanProjects(config);
  const result = await readConversationHistory(projects[0].archive, cwd, config);
  assert.deepEqual(dialogue(result), [['user', 'Check the release'], ['assistant', 'Packaging works.']]);
  assert.deepEqual(result.trace.map(item => [item.kind, item.status]), [
    ['summary', 'ok'], ['tool_call', 'ok'], ['tool_result', 'ok'],
  ]);
  assert.equal(result.trace[2].text, 'package.tgz');
  assert.deepEqual(result.messages[1].traceIds, result.trace.map(item => item.id));
  assert.deepEqual(result.sourceStats, {
    userMessages: 1, assistantMessages: 1, importedMessages: 2, partial: false, tokens: { total: 22 },
  });
});

test('Claude parallel tool calls stay paired and a tool-result-only user row is not a new question', async t => {
  const { root, cwd } = await fixture(t);
  const claude = path.join(root, '.claude');
  await writeJsonl(path.join(claude, 'projects', 'workspace', 'trace.jsonl'), [
    { type: 'user', cwd, message: { content: 'Fix checkout' } },
    {
      type: 'assistant', message: {
        content: [
          { type: 'thinking', text: 'hidden-claude-reasoning' },
          { type: 'text', text: 'Looking at both files.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/a.js' } },
          { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    },
    {
      type: 'user', message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'const a = 1' }] },
          { type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: 'Command failed' },
        ],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Checkout fixed.' }] } },
  ]);
  const config = { agentRoots: { claude: [claude] } };
  const { projects } = await scanProjects(config);
  const result = await readConversationHistory(projects[0].archive, cwd, config);
  assert.deepEqual(dialogue(result), [
    ['user', 'Fix checkout'], ['assistant', 'Looking at both files.'], ['assistant', 'Checkout fixed.'],
  ]);
  assert.equal(result.trace.some(item => item.text.includes('hidden-claude-reasoning')), false);
  const calls = result.trace.filter(item => item.kind === 'tool_call');
  const results = result.trace.filter(item => item.kind === 'tool_result');
  assert.deepEqual(calls.map(item => [item.callId, item.status]), [['toolu_1', 'ok'], ['toolu_2', 'error']]);
  assert.deepEqual(results.map(item => [item.callId, item.text]), [['toolu_1', 'const a = 1'], ['toolu_2', 'Command failed']]);
});
