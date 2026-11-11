import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
const origin = 'http://127.0.0.1:8300';
const panelUrl = `${origin}/agent-bridge/panel`;

function mount({ rows, events = () => { throw new Error('Unexpected history read'); } }) {
  const replies = [];
  let onMessage;
  let renderPanel;
  let plugin;
  const frame = { location: { href: panelUrl }, postMessage: (message) => replies.push(structuredClone(message)) };
  const window = {
    origin,
    __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => ({
      createElement() {},
      useEffect: (effect) => effect(),
      useRef: () => ({ current: { contentWindow: frame } }),
    })); } },
    addEventListener: (_type, listener) => { onMessage = listener; },
  };
  runInNewContext(source, { window, document: { baseURI: `${origin}/` }, URL, AbortController, AbortSignal });
  plugin.apply({
    effect: (effect) => effect(),
    locale: { register() {}, bind: () => value => value },
    slots: {
      inject: (_slot, register) => register(),
      register: (props, render) => { if (props.name === 'main') renderPanel = render; },
    },
    sessions: { list: { getSnapshot: () => ({
      phase: 'ready', ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])),
    }) } },
    remote: { session: { events } },
  });
  renderPanel();
  return async (type, data = {}, event = {}) => {
    replies.length = 0;
    await onMessage({ origin, source: frame, data: { type: `dsh-agent-bridge:${type}`, requestId: 'req-1', ...data }, ...event });
    return replies[0];
  };
}

const project = { id: 'session-a', title: 'Project session', cwd: 'C:\\Code\\Project', updatedAt: 5 };
const other = { id: 'session-b', title: 'Other session', cwd: 'C:\\Code\\Other' };
const user = (seq, text, source = 'user', surfaceOp = 'append') => ({
  type: 'event', event: { seq, type: 'user/message', surfaceOp, data: {
    source: { kind: source }, content: [{ type: 'text', text }],
  } },
});
const assistant = (seq, text) => ({
  type: 'event', event: { seq, type: 'assistant/message', surfaceOp: 'append', data: {
    message: { content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text }] },
  } },
});

test('native export lists visible workspace chats and rejects foreign frames or scope', async () => {
  const send = mount({ rows: [project, other, { ...project, id: 'blank', blank: true },
    { ...project, id: 'subagent', origin: 'subagent' }] });
  assert.deepEqual((await send('sessions')).sessions.map(row => row.id), ['session-a', 'session-b']);
  assert.deepEqual((await send('sessions', { path: 'c:/code/project/' })).sessions.map(row => row.id), ['session-a']);
  assert.equal((await send('session-export', { path: project.cwd, sessionId: other.id })).ok, false);
  assert.equal(await send('sessions', {}, { origin: 'https://unrelated.example' }), undefined);
  assert.equal(await send('sessions', {}, { source: { location: { href: panelUrl } } }), undefined);
});

test('native export pages at one cut and includes chronological human and assistant text only', async () => {
  const requests = [];
  const send = mount({ rows: [project], events: async (request) => {
    requests.push(structuredClone(request));
    return { ok: true, value: request.beforeSeq === undefined
      ? { cursor: 9, records: [user(5, 'internal', 'runtime-context'), assistant(9, 'Visible answer')], hasMore: true }
      : { cursor: 9, records: [user(2, 'Visible prompt'), user(3, 'rewrite', 'user', 'replace')], hasMore: false } };
  } });
  const result = await send('session-export', { sessionId: project.id });
  assert.equal(result.ok, true);
  assert.deepEqual(result.conversation, { title: project.title, path: project.cwd, truncated: false, messages: [
    { role: 'user', text: 'Visible prompt' }, { role: 'assistant', text: 'Visible answer' },
  ] });
  assert.deepEqual(requests[1], { ...requests[0], beforeSeq: 5, throughSeq: 9 });
});

test('native export preserves the latest long reply within its text budget', async () => {
  const text = `A${'🐋'.repeat(15_000)}`;
  const send = mount({ rows: [project], events: async () => ({
    ok: true, value: { cursor: 7, records: [assistant(7, text)], hasMore: false },
  }) });
  const result = await send('session-export', { sessionId: project.id });
  assert.equal(result.conversation.truncated, true);
  assert.equal(result.conversation.messages[0].text.length, 27_999);
  assert.equal(result.conversation.messages[0].text.isWellFormed(), true);
});
