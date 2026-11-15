import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
const origin = 'http://127.0.0.1:8300';
const panelUrl = `${origin}/agent-bridge/panel`;

function mount({ rows, events = () => { throw new Error('Unexpected history read'); }, services }) {
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
    ...services,
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

function draftHandoff({ outcome, archiveFails = false, draft = '' }) {
  const sessions = new Map();
  const opened = [];
  const retained = new Set();
  const send = mount({ rows: [], services: {
    sessions: {
      async create() {
        const id = 'new-' + (sessions.size + 1);
        sessions.set(id, { blank: true, running: false, archived: false, draft });
        return id;
      },
      retain(id) {
        retained.add(id);
        const row = sessions.get(id);
        return { binding: { sessionId: id, ctx: { row }, session: { getSnapshot: () => row } }, ready: Promise.resolve(),
          release: () => retained.delete(id) };
      },
    },
    workspaces: {
      async create() { return { workspaceId: 'import-workspace' }; },
      async archiveSession(id, options) {
        if (archiveFails || options?.stopActivity) throw new Error('Cannot archive');
        sessions.get(id).archived = true;
      },
    },
    conversation: { input: {
      for(ctx) { return { snapshot: { draft: ctx.row.draft, attachmentIds: [] } }; },
      requestDraftInitialization(binding, { prompt, whenDraftExists }) {
        const row = sessions.get(binding.sessionId);
        const status = outcome(row, whenDraftExists);
        if (status === 'applied') row.draft = prompt;
        return status;
      },
    } },
    uiWorkspace: { openSession: id => opened.push(id) },
  } });
  return { send, sessions, opened, retained };
}

const handoff = { path: project.cwd, prompt: 'Continue from the reviewed project.' };

test('a refused handoff draft archives the new blank chat and retries without leaving it visible', async () => {
  let attempts = 0;
  const { send, sessions, opened, retained } = draftHandoff({
    outcome: () => ++attempts === 1 ? 'blocked' : 'applied',
  });
  const failed = await send('open', handoff);
  assert.equal(failed.ok, false);
  assert.equal(sessions.get('new-1').archived, true);
  assert.equal(failed.recoverySessionId, undefined);
  assert.deepEqual(opened, []);
  assert.equal(retained.size, 0);
  const retried = await send('open', handoff);
  assert.equal(retried.ok, true);
  assert.deepEqual(opened, ['new-2']);
  assert.equal(sessions.get('new-2').draft, handoff.prompt);
});

test('a preserved draft stays intact and the same chat can be opened for manual recovery', async () => {
  const { send, sessions, opened } = draftHandoff({ outcome: () => 'preserved', draft: 'User draft' });
  const result = await send('open', handoff);
  assert.equal(result.ok, false);
  assert.equal(result.recoverySessionId, 'new-1');
  assert.equal(sessions.get('new-1').draft, 'User draft');
  assert.equal(sessions.get('new-1').archived, false);
  assert.deepEqual(opened, []);
  assert.equal((await send('recover-draft', { requestId: 'other-ticket', sessionId: result.recoverySessionId })).ok, false);
  assert.equal((await send('recover-draft', { sessionId: result.recoverySessionId })).ok, true);
  assert.deepEqual(opened, ['new-1']);
  assert.equal(sessions.size, 1);
});

test('when the rollback fails, retry reuses the partial session instead of creating a duplicate', async () => {
  let attempts = 0;
  const { send, sessions, opened } = draftHandoff({ archiveFails: true, outcome: () => {
    if (++attempts === 1) throw new Error('Draft failed');
    return 'applied';
  } });
  const failed = await send('open', handoff);
  assert.equal(failed.ok, false);
  assert.equal(failed.recoverySessionId, 'new-1');
  // A new preview may issue a different ticket for the same project.
  const recovered = await send('open', { ...handoff, requestId: 'new-ticket' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.sessionId, 'new-1');
  assert.deepEqual(opened, ['new-1']);
  assert.equal(sessions.size, 1);
});
