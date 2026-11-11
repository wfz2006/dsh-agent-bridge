import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSourceMonitor } from '../src/watch.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-bridge-watch-'));
  let waiting;
  let count = 0;
  const monitor = createSourceMonitor({ debounceMs: 25, onChange() { count++; waiting?.(); } });
  t.after(async () => {
    monitor.dispose();
    await rm(root, { recursive: true, force: true });
  });
  async function expectChange(write) {
    let timeout;
    const observed = new Promise((resolve, reject) => {
      waiting = resolve;
      timeout = setTimeout(() => reject(new Error('No file change was observed')), 2_000);
    });
    try { await Promise.all([observed, write()]); }
    finally { clearTimeout(timeout); waiting = undefined; }
  }
  return { root, monitor, expectChange, changes: () => count };
}

test('database file changes invalidate the catalog while SQLite shared-memory and unrelated writes stay quiet', async t => {
  const { root, monitor, expectChange, changes } = await fixture(t);
  const archive = path.join(root, 'sessions.db');
  const config = { configFile: path.join(root, 'agent-bridge.json'), archiveFiles: [archive] };
  await monitor.update(config);
  await expectChange(() => writeFile(`${archive}-wal`, 'new session metadata'));
  await delay(75);

  const before = changes();
  await Promise.all([writeFile(`${archive}-shm`, 'internal'), writeFile(path.join(root, 'unrelated.txt'), 'unrelated')]);
  await delay(100);
  assert.equal(changes(), before);

  await expectChange(() => writeFile(config.configFile, '{}'));
  monitor.dispose();
  const stopped = changes();
  await appendFile(`${archive}-wal`, 'more');
  await delay(100);
  assert.equal(changes(), stopped);
});

test('selected project detects a new bridge directory, subsequent memory and handoff edits, and a nested Skill', async t => {
  const { root, monitor, expectChange } = await fixture(t);
  const cwd = path.join(root, 'project');
  const bridge = path.join(cwd, '.agent-bridge');
  const memory = path.join(bridge, 'memory', 'current-state.md');
  const handoff = path.join(bridge, 'handoffs', 'latest-handoff.md');
  const skill = path.join(cwd, '.claude', 'skills', 'release', 'SKILL.md');
  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(skill, '# Existing skill');
  await monitor.update({}, [{ cwd, projectIds: [] }]);

  await expectChange(() => mkdir(path.dirname(memory), { recursive: true }));
  await delay(75);
  await monitor.update({}, [cwd]);
  await expectChange(() => writeFile(memory, '# New memory'));
  await delay(75);
  await expectChange(() => mkdir(path.dirname(handoff), { recursive: true }));
  await delay(75);
  await monitor.update({}, [cwd]);
  await expectChange(() => writeFile(handoff, '# Handoff'));
  await delay(75);
  await expectChange(() => appendFile(handoff, '\nStill current'));
  await delay(75);
  await expectChange(() => appendFile(skill, '\nNew release details'));
});
