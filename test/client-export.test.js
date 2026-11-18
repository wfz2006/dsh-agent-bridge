import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
const packageData = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const origin = 'http://127.0.0.1:8300';
const panelUrl = `${origin}/agent-bridge/panel`;

test('client registrations use the installed package name', () => {
  assert.ok(source.includes(`id: '${packageData.name}'`));
});

function mount({ rows, events = () => { throw new Error('Unexpected history read'); }, services, fetch }) {
  const replies = [];
  let onMessage;
  let renderPanel;
  let plugin;
  const slots = new Map();
  const frame = { location: { href: panelUrl }, postMessage: (message) => replies.push(structuredClone(message)) };
  const window = {
    origin,
    __ModuleLoader__: { load: ({ factory }) => { plugin = factory(name => name === 'react-dom'
      ? { createPortal: node => node }
      : {
        createElement() {},
        useEffect: (effect) => effect(),
        useRef: () => ({ current: { contentWindow: frame } }),
        useState: init => [typeof init === 'function' ? init() : init, () => {}],
        useCallback: fn => fn,
      }); } },
    addEventListener: (_type, listener) => { onMessage = listener; },
  };
  runInNewContext(source, { window, document: { baseURI: `${origin}/` }, URL, AbortController, AbortSignal, fetch });
  plugin.apply({
    effect: (effect) => effect(),
    locale: { register() {}, bind: () => value => value },
    slots: {
      inject: (_slot, register) => register(),
      register: (props, render) => {
        slots.set(props.name, render);
        if (props.name === 'main') renderPanel = render;
      },
    },
    sessions: { list: { getSnapshot: () => ({
      phase: 'ready', ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])),
    }) } },
    remote: { session: { events } },
    ...services,
  });
  renderPanel();
  const send = async (type, data = {}, event = {}) => {
    replies.length = 0;
    await onMessage({ origin, source: frame, data: { type: `dsh-agent-bridge:${type}`, requestId: 'req-1', ...data }, ...event });
    return replies[0];
  };
  send.slots = slots;
  return send;
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

test('the panel can only ask the host to open a verified project path', async () => {
  const opened = [];
  const checks = [];
  const ids = { projectId: '1'.repeat(24), referenceId: '01234567-0123-0123-0123-012345678901', bridgeNonce: '2'.repeat(64) };
  const fetch = async (url, options) => {
    assert.equal(url.href, `${origin}/agent-bridge/api`);
    assert.equal(options.headers['X-DSH-Agent-Bridge'], ids.bridgeNonce);
    checks.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ path: 'D:\\Demo\\AGENTS.md' }) };
  };
  const send = mount({ rows: [], fetch, services: {
    remote: { session: {
      async canOpenWorkspacePath() { return { ok: true, value: true } },
      async openWorkspacePath({ path, action }) {
        opened.push([path, action]);
        return { ok: action === 'reveal' };
      },
    } },
  } });
  assert.equal((await send('open-path', { path: 'D:\\Demo\\AGENTS.md' })).ok, false);
  const revealed = await send('open-path', { ...ids, path: 'D:\\Unchecked.md' });
  assert.equal(revealed.ok, true);
  assert.equal(revealed.revealed, true);
  assert.deepEqual(opened, [['D:\\Demo\\AGENTS.md', undefined], ['D:\\Demo\\AGENTS.md', 'reveal']]);
  assert.deepEqual(checks, Array.from({ length: 2 }, () => ({
    action: 'resolve-open-path', projectId: ids.projectId, referenceId: ids.referenceId,
  })));
  assert.equal((await send('open-path', { path: '' })).ok, false);
  assert.equal((await send('open-path', { path: 'D:\\a\nb' })).ok, false);
  assert.equal((await send('open-path', { path: 'D:\\Demo' }, { origin: 'https://unrelated.example' })), undefined);
  assert.equal((await send('open-path', { path: 'D:\\Demo' }, { source: { location: { href: panelUrl } } })), undefined);
  const refused = mount({ rows: [], services: { remote: { session: {
    async canOpenWorkspacePath() { return { ok: true, value: false } },
    async openWorkspacePath() { throw new Error('must not be called'); },
  } } } });
  const result = await refused('open-path', ids);
  assert.equal(result.ok, false);
  assert.match(result.error, /不支持打开本机文件/);
});

test('the session header offers a read-only source record entry when the host exposes the slot', () => {
  const send = mount({ rows: [] });
  const trace = send.slots.get('conversation.session.header.actions');
  assert.equal(typeof trace, 'function');
  assert.match(source, /agent-bridge\/session-trace\?sessionId=/);
  assert.match(source, /conversation\.session\.header\.actions/);
  assert.match(source, /createPortal/);
});

test('quoting saved history appends to the selected DSH draft without submitting', async () => {
  const binding = { ctx: {} };
  const actions = [];
  let outcome = 'applied';
  const send = mount({
    rows: [project],
    services: {
      sessions: {
        list: { getSnapshot: () => ({ phase: 'ready', ids: [project.id], byId: { [project.id]: project } }) },
        retain: (id) => {
          actions.push(['retain', id]);
          return { binding, ready: Promise.resolve(), release: () => actions.push(['release', id]) };
        },
      },
      conversation: { input: { requestDraftInitialization: (current, options) => {
        assert.equal(current, binding);
        actions.push(['draft', structuredClone(options)]);
        return outcome;
      } } },
      uiWorkspace: { openSession: (id) => actions.push(['open', id]) },
    },
  });

  assert.equal((await send('quote-history', { sessionId: other.id, text: 'outside' })).ok, false);
  assert.deepEqual(actions, []);
  assert.equal((await send('quote-history', { sessionId: project.id, text: '早期结果\n\n末行' })).ok, true);
  assert.deepEqual(actions, [
    ['retain', project.id],
    ['draft', { prompt: '> 早期结果\n> \n> 末行\n\n', whenDraftExists: 'append' }],
    ['release', project.id],
    ['open', project.id],
  ]);

  outcome = 'preserved';
  actions.length = 0;
  const previous = await send('quote-history', { sessionId: project.id, text: '仍有草稿' });
  assert.equal(previous.ok, false);
  assert.match(previous.error, /已有草稿/);
  assert.equal(actions.some(([action]) => action === 'open'), false);
});

test('history directory browsing uses the DSH picker and lets the user cancel without opening a workspace', async () => {
  let selected = other.cwd;
  let calls = 0;
  const send = mount({
    rows: [],
    services: { uiWorkspace: { pickDirectory: async () => { calls++; return selected; } } },
  });
  assert.equal(await send('pick-history-directory', {}, { origin: 'https://foreign.example' }), undefined);
  assert.equal(calls, 0);
  assert.equal((await send('pick-history-directory')).path, other.cwd);
  selected = null;
  const cancelled = await send('pick-history-directory');
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.path, null);
  assert.equal(calls, 2);
});
