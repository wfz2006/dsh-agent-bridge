import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import * as sources from '../src/projects.js';
const { readConversationHistory, readProjectHistory, scanProjects } = sources;

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

test('native Qwen tool_result rows retain output and errors without creating user turns', async t => {
  const { root, cwd } = await fixture(t);
  const file = path.join(root, 'projects', 'workspace', 'chats', 'qwen.jsonl');
  await writeJsonl(file, [
    { type: 'user', cwd, message: { parts: [{ text: 'Qwen question' }] } },
    { type: 'assistant', message: { parts: [
      { functionCall: { id: 'qwen-call-a', name: 'read', args: {} } },
      { functionCall: { id: 'qwen-call-b', name: 'read', args: {} } },
    ] } },
    { type: 'tool_result', message: { parts: [
      { functionResponse: { id: 'qwen-call-b', name: 'read', response: { error: 'Unavailable' } } },
      { functionResponse: { id: 'qwen-call-a', name: 'read', response: { output: 'First\n\nsecond' } } },
    ] } },
    { type: 'assistant', message: { parts: [{ text: 'Qwen answer' }] } },
  ]);
  const config = { agentRoots: { qwen: [root] } };
  const events = await fullHistory({ kind: 'qwen', file }, cwd, config);
  assert.deepEqual(events.filter(event => event.kind === 'message').map(event => [event.role, event.turn]),
    [['user', 1], ['assistant', 1]]);
  assert.deepEqual(events.filter(event => event.kind === 'tool_result').map(event => [event.callId, event.text, event.status]),
    [['qwen-call-b', 'Unavailable', 'error'], ['qwen-call-a', 'First\n\nsecond', 'ok']]);
});

test('native WorkBuddy callId and function_call_result retain the matching output', async t => {
  const { root, cwd } = await fixture(t);
  const workbuddy = path.join(root, 'workbuddy');
  const file = path.join(workbuddy, 'projects', 'workspace', 'native.jsonl');
  await writeJsonl(file, [
    { type: 'message', cwd, role: 'user', content: 'Question' },
    { type: 'reasoning', cwd, id: 'reasoning-row', timestamp: '2026-11-18T00:00:00Z', content: [],
      rawContent: [{ type: 'reasoning_text', text: 'Recorded WorkBuddy thinking.' },
        { type: 'encrypted_content', text: 'Opaque source payload' }] },
    { type: 'function_call', cwd, id: 'record-a', callId: 'call-a', name: 'read', arguments: '{}' },
    { type: 'function_call_result', cwd, id: 'record-b', callId: 'call-a', name: 'read', output: [{ type: 'text', text: 'found' }], status: 'completed' },
    { type: 'function_call', cwd, id: 'record-c', callId: 'call-b', name: 'read', arguments: '{}' },
    { type: 'function_call_result', cwd, id: 'record-d', callId: 'call-b', name: 'read', output: { type: 'text', text: 'unfinished' }, status: 'incomplete' },
    { type: 'message', cwd, role: 'assistant', content: 'Replied' },
  ]);
  const config = { agentRoots: { workbuddy: [workbuddy] } };
  const { projects: [entry] } = await scanProjects(config);
  const items = await fullHistory(entry.archive, cwd, config);
  assert.deepEqual(items.filter(item => item.kind === 'summary').map(item => [item.turn, item.text]),
    [[1, 'Recorded WorkBuddy thinking.']]);
  assert.equal(items.find(item => item.kind === 'tool_call').callId, 'call-a');
  assert.deepEqual(items.filter(item => item.kind === 'tool_result').map(({ callId, text, status }) => [callId, text, status]),
    [['call-a', 'found', 'ok'], ['call-b', 'unfinished', 'incomplete']]);
});

async function fullHistory(archive, cwd, config) {
  const events = [];
  for await (const event of sources.readSourceEvents(archive, { sourceCwd: cwd, config })) events.push(event);
  return events;
}

test('mixed Claude assistant blocks retain thinking, Markdown and tool positions from the same message', async t => {
  const { root, cwd } = await fixture(t);
  const file = path.join(root, 'projects', 'workspace', 'mixed.jsonl');
  const markdown = ['# C#', '', '```csharp', 'int a = 1;', '', '', 'int b = 2;', '```'].join('\n');
  await writeJsonl(file, [
    { type: 'user', cwd, message: { content: 'Question' } },
    { type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'First recorded thought' },
      { type: 'text', text: 'Looking at the project.' },
      { type: 'tool_use', id: 'toolu_group', name: 'Read', input: { file_path: 'project.md' } },
      { type: 'redacted_thinking', data: 'ENCRYPTED_DATA' },
      { type: 'thinking', thinking: 'Second recorded thought' },
      { type: 'text', text: markdown },
    ] } },
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_group', content: 'Project contents' },
    ] } },
  ]);
  const events = await fullHistory({ kind: 'claude', file }, cwd, { agentRoots: { claude: [root] } });
  assert.deepEqual(events.filter(item => item.kind !== 'metadata').map(item => [item.kind, item.text]), [
    ['message', 'Question'],
    ['summary', 'First recorded thought'],
    ['message', 'Looking at the project.'],
    ['tool_call', '{"file_path":"project.md"}'],
    ['summary', 'Second recorded thought'],
    ['message', markdown],
    ['tool_result', 'Project contents'],
  ]);
});

test('Codex discovers plain files missing from a populated index', async t => {
  const { root, cwd } = await fixture(t);
  const first = path.join(root, 'sessions', 'listed.jsonl');
  const other = path.join(root, 'archived_sessions', 'unlisted.jsonl');
  await writeJsonl(first, [codexMeta(cwd, 'indexed'), codexRow('user', 'Indexed')]);
  await writeJsonl(other, [codexMeta(cwd, 'unindexed'), codexRow('user', 'Unindexed')]);
  codexIndex(root, [['indexed', cwd, first, 1_794_009_600, 'Indexed']]);
  const result = await scanProjects({ agentRoots: { codex: [root] } });
  assert.deepEqual(result.projects.map(item => item.archive.id).sort(), ['indexed', 'unindexed']);
});

test('database-backed discovery reaches sessions beyond the former 8000-row cutoff', async t => {
  const { root, cwd } = await fixture(t);
  const store = path.join(root, 'opencode.db');
  const db = new DatabaseSync(store);
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER); BEGIN');
  const insert = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)');
  for (let index = 0; index <= 8_000; index++) insert.run('archive-' + index, cwd, index);
  db.exec('COMMIT');
  db.close();
  const { projects } = await scanProjects({ agentRoots: { opencode: [store] } });
  assert.equal(projects.length, 8_001);
  assert.ok(projects.some(project => project.archive?.id === 'archive-0'));
});

test('full Codex readers preserve the first turn and oversized CRLF messages in plain and compressed files', zstdOptions, async t => {
  const { root, cwd } = await fixture(t);
  const plain = path.join(root, 'sessions', 'full.jsonl');
  const compressed = path.join(root, 'sessions', 'full-copy.jsonl.zst');
  const long = '  ```csharp\r\n' + '中🧪 '.repeat(70_000) + '\r\n\r\n```\n';
  function* transcript(id) {
    yield jsonl(codexMeta(cwd, id));
    yield jsonl(codexRow('user', 'First'));
    for (let position = 0; position < 620; position++) {
      yield jsonl(codexRow('assistant', position === 309 ? long : 'x'.repeat(21_000)));
    }
    yield jsonl(codexRow('assistant', 'Last'));
  }
  await mkdir(path.dirname(plain));
  await pipeline(Readable.from(transcript('plain')), createWriteStream(plain));
  await writeZstd(compressed, transcript('compressed'));
  const config = { agentRoots: { codex: [root] } };
  const { projects } = await scanProjects(config);
  let reference;
  for (const { archive } of projects) {
    const options = { sourceCwd: cwd, config };
    assert.deepEqual(await sources.probeConversation(archive, options), { state: 'ready' });
    const events = await fullHistory(archive, cwd, config);
    const messages = events.filter(event => event.kind === 'message');
    assert.equal(messages.length, 622);
    assert.equal(messages[0].text, 'First');
    assert.equal(messages[310].text, long);
    assert.equal(messages.at(-1).text, 'Last');
    assert.equal(events.some(event => event.kind === 'gap'), false);
    const texts = messages.map(message => message.text);
    if (reference) assert.deepEqual(texts, reference);
    reference = texts;
  }
});

test('full archive source probe distinguishes an image-only user, metadata, and a torn record', async t => {
  const { root, cwd } = await fixture(t);
  const config = { agentRoots: { codex: [root] } };
  const file = path.join(root, 'sessions', 'photo.jsonl');
  await writeJsonl(file, [codexMeta(cwd, 'photo'), { type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAEC' }],
  } }]);
  const archive = { file, kind: 'codex', id: 'photo' };
  const options = { config, sourceCwd: cwd };
  assert.deepEqual(await sources.probeConversation(archive, options), { state: 'ready' });
  const [image] = await fullHistory(archive, cwd, config);
  assert.equal(image.kind, 'attachment');
  assert.equal(image.role, 'user');
  assert.equal(image.turn, 1);
  assert.equal(image.standalone, true);
  assert.deepEqual(image.data, Buffer.from([0, 1, 2]));
  await writeJsonl(file, [codexMeta(cwd, 'photo'), codexRow('user', '<environment_context>setup</environment_context>')]);
  assert.deepEqual(await sources.probeConversation(archive, options), { state: 'empty' });
  await writeFile(file, jsonl(codexMeta(cwd, 'photo')) + '{');
  assert.deepEqual(await sources.probeConversation(archive, options), { state: 'unknown', reason: 'malformed-record' });
  assert.deepEqual(await sources.probeConversation(archive, { ...options, sourceCwd: root }), { state: 'unknown', reason: 'source-mismatch' });
});

test('full Codex archives preserve explicit source turn interruption despite assistant text', async t => {
  const { root, cwd } = await fixture(t);
  const file = path.join(root, 'sessions', 'turn-status.jsonl');
  const config = { agentRoots: { codex: [root] } };
  await writeJsonl(file, [
    codexMeta(cwd, 'turn-status'),
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } },
    codexRow('user', 'A'), codexRow('assistant', 'Looking'),
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-b' } },
    codexRow('user', 'B'), codexRow('assistant', 'Done'),
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-a' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-b' } },
  ]);
  const events = await fullHistory({ kind: 'codex', id: 'turn-status', file }, cwd, config);
  assert.deepEqual(events.filter(event => event.kind === 'turn_end').map(event => [event.turn, event.status]),
    [[1, 'interrupted'], [2, 'completed']]);
});

test('a source snapshot excludes appends made after the first message was read', async t => {
  const { root, cwd } = await fixture(t);
  const file = path.join(root, 'sessions', 'growing.jsonl');
  const config = { agentRoots: { codex: [root] } };
  const archive = { kind: 'codex', file, id: 'growing' };
  await writeJsonl(file, [codexMeta(cwd, 'growing'), codexRow('user', 'At open'), codexRow('assistant', 'Already present')]);
  const reader = sources.readSourceEvents(archive, { config, sourceCwd: cwd });
  assert.equal((await reader.next()).value.text, 'At open');
  await appendFile(file, jsonl(codexRow('user', 'Appended later')));
  const retained = [];
  for await (const event of reader) retained.push(event);
  assert.deepEqual(retained.map(event => event.text), ['Already present']);
  assert.equal((await fullHistory(archive, cwd, config)).at(-1).text, 'Appended later');
});

test('a corrupt compressed source never claims complete history', zstdOptions, async t => {
  const { root, cwd } = await fixture(t);
  const file = path.join(root, 'sessions', 'truncated.jsonl.zst');
  const config = { agentRoots: { codex: [root] } };
  const archive = { kind: 'codex', file };
  await writeZstd(file, [codexMeta(cwd, 'truncated'), codexRow('user', 'Retained question')].map(jsonl));
  const bytes = await readFile(file);
  await writeFile(file, bytes.subarray(0, bytes.length - 2));
  const events = await fullHistory(archive, cwd, config);
  assert.ok(events.some(event => event.kind === 'gap' && event.reason === 'corrupt-compressed-source'));
});

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
  const full = await fullHistory(project.archive, cwd, config);
  assert.deepEqual(full.filter(event => event.kind === 'message').map(event => event.text), ['Build the bridge', 'Bridge built']);
  assert.equal(Object.prototype.tainted, undefined);
});

test('Gemini full archive retains text, explicit tool IDs and known multipart attachment references', async t => {
  const { root, cwd } = await fixture(t);
  const gemini = path.join(root, '.gemini');
  const temp = path.join(gemini, 'tmp', 'workspace');
  const chat = path.join(temp, 'chats', 'session-example.json');
  await mkdir(path.dirname(chat), { recursive: true });
  await writeFile(path.join(temp, '.project_root'), cwd);
  await writeFile(chat, JSON.stringify({ messages: [
    { id: 'u', type: 'user', content: [{ text: 'Inspect' }, { fileData: { mimeType: 'image/png', fileUri: 'https://example.invalid/photo.png' } }] },
    { id: 'a', type: 'gemini', content: 'The answer', toolCalls: [{ name: 'read_file', id: 'gemini-call', args: {},
      result: 'File contents', status: 'success' }] },
  ] }));
  const config = { agentRoots: { gemini: [gemini] } };
  const { projects } = await scanProjects(config);
  const events = await fullHistory(projects.find(item => item.archive).archive, cwd, config);
  assert.deepEqual(events.map(event => [event.kind, event.status]), [
    ['message', undefined], ['attachment', 'remote-reference'], ['message', undefined],
    ['tool_call', 'pending'], ['tool_result', 'ok'],
  ]);
  assert.equal(events.at(-1).callId, 'gemini-call');
});

test('Copilot discovers and reads native session-store SQLite v3 independently of editor JSONL', async t => {
  const { root, cwd } = await fixture(t);
  const store = path.join(root, 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'session-store.db');
  await mkdir(path.dirname(store), { recursive: true });
  const db = new DatabaseSync(store);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER);
    INSERT INTO schema_version VALUES (3);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, host_type TEXT, summary TEXT, updated_at TEXT);
    CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT);
    INSERT INTO turns VALUES (1, 'cp', 5, 'Later', NULL, '2026-11-18T12:00:00Z');
    INSERT INTO turns VALUES (2, 'cp', 0, 'First', 'A full response', '2026-11-18T11:00:00Z');
  `);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('cp', cwd, 'vscode', 'SQLite conversation', '2026-11-18T12:00:00Z');
  db.close();
  const config = { agentRoots: { copilot: [path.join(root, 'Code'), path.join(root, 'Code', 'User')] } };
  const { projects } = await scanProjects(config);
  const [archive] = projects.map(project => project.archive).filter(Boolean);
  assert.equal(projects.filter(project => project.archive?.id === 'cp').length, 1);
  assert.equal(archive.title, 'SQLite conversation');
  assert.equal(archive.file, store);
  const before = await readFile(store);
  const events = await fullHistory(archive, cwd, config);
  assert.deepEqual(events.filter(event => event.kind === 'message').map(({ role, text }) => [role, text]),
    [['user', 'First'], ['assistant', 'A full response'], ['user', 'Later']]);
  assert.equal(events.some(event => event.kind === 'gap' && event.reason === 'source-dialogue-only'), true);
  assert.deepEqual(await readFile(store), before);
  assert.deepEqual(await sources.probeConversation(archive, { sourceCwd: root, config }), { state: 'unknown', reason: 'source-mismatch' });
});

test('full OpenCode legacy archives retain all text and pair tool records by source call ID', async t => {
  const { root, cwd } = await fixture(t);
  const store = path.join(root, 'opencode.db');
  const db = new DatabaseSync(store);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER);
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('legacy', cwd, 1);
  const addMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  addMessage.run('u', 'legacy', '{"role":"user"}', 1);
  addMessage.run('a', 'legacy', '{"role":"assistant"}', 2);
  const addPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
  addPart.run('p', 'legacy', 'u', '{"type":"text","text":"Question"}', 1);
  for (let index = 0; index < 108; index++) addPart.run(`text${index}`, 'legacy', 'a', JSON.stringify({ type: 'text', text: 'Part ' + index }), index);
  addPart.run('tool', 'legacy', 'a', JSON.stringify({ type: 'tool', tool: 'read', callID: 'source-id',
    state: { status: 'error', input: { path: 'example' }, error: 'Failed' } }), 109);
  db.close();
  const config = { agentRoots: { opencode: [store] } };
  const { projects } = await scanProjects(config);
  const [archive] = projects.map(project => project.archive).filter(Boolean);
  const events = await fullHistory(archive, cwd, config);
  assert.match(events.find(event => event.role === 'assistant').text, /Part 107$/);
  assert.deepEqual(events.filter(event => event.kind.startsWith('tool_')).map(event => [event.kind, event.callId, event.status]),
    [['tool_call', 'source-id', 'pending'], ['tool_result', 'source-id', 'error']]);
});

test('full OpenCode v2 supplements a message from same-session parts and preserves explicit idle outcome', async t => {
  const { root, cwd } = await fixture(t);
  const store = path.join(root, 'opencode.db');
  const db = new DatabaseSync(store);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
    CREATE TABLE session_part (session_id TEXT, message_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT, data TEXT);
    INSERT INTO session_message VALUES ('u', 'v2', 'user', 0, 1, '{"text":"Question","files":[]}');
    INSERT INTO session_message VALUES ('a', 'v2', 'assistant', 1, 2, '{"content":[{"type":"text","text":"Answer"}]}');
    INSERT INTO session_message VALUES ('end', 'v2', 'idle', 2, 3, '{"outcome":"succeeded"}');
    INSERT INTO session_part VALUES ('v2', 'a', 0, 'text', NULL, '{"text":"Answer"}');
    INSERT INTO session_part VALUES ('v2', 'a', 1, 'tool', 'v2-call', '{"name":"read","state":{"status":"completed","content":[{"type":"text","text":"Old result"}]},"time":{"created":1795010000000,"completed":1795010000040}}');
    INSERT INTO session_part VALUES ('other', 'a', 2, 'text', NULL, '{"text":"Foreign text"}');
  `);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)').run('v2', cwd, 1);
  db.close();
  const config = { agentRoots: { opencode: [store] } };
  const { projects } = await scanProjects(config);
  const [archive] = projects.map(project => project.archive).filter(Boolean);
  const events = await fullHistory(archive, cwd, config);
  assert.deepEqual(events.filter(event => event.kind === 'message').map(event => event.text), ['Question', 'Answer']);
  assert.deepEqual(events.filter(event => event.kind === 'tool_result').map(event => [event.callId, event.text]), [['v2-call', 'Old result']]);
  assert.deepEqual(events.filter(event => event.kind.startsWith('tool_')).map(event => event.time), [1795010000000, 1795010000040]);
  assert.deepEqual(events.filter(event => event.kind === 'turn_end').map(event => [event.turn, event.status]), [[1, 'completed']]);
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
