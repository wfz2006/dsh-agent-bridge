import { watch } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const maxWatchers = 224;
const maxSelected = 5;
const maxRootsPerAgent = 12;
const planLifetime = 30_000;
const note = /\.(?:md|markdown)$/i;
const transcript = /\.jsonl(?:\.zst)?$/i;
const skill = /^skill\.md$/i;
const projectFolders = [
  '.agent', '.agents', '.claude', '.codex', '.dsh', '.gemini', '.opencode',
  '.qoder', '.qwen', '.trae', '.workbuddy',
];
const hubFolders = ['决策', '经验', '资料', '交接', '笔记'];
const aliases = {
  'claude-code': 'claude', 'codex-cli': 'codex', 'open-code': 'opencode', 'qoder-cn': 'qoder',
  'qwen-code': 'qwen', 'trae-cn': 'trae', 'trae-solo': 'trae', 'gemini-cli': 'gemini',
  'antigravity-cli': 'antigravity', vscode: 'copilot', 'vscode-insiders': 'copilot',
  'vscode-copilot': 'copilot', vscodium: 'copilot', 'code-oss': 'copilot',
};
const all = () => true;
const matches = pattern => name => pattern.test(name);
const named = (...values) => {
  const names = new Set(values.map(value => value.toLowerCase()));
  return name => names.has(name.toLowerCase());
};

function fileKey(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function recentDirectories(directory, limit) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const candidates = entries.filter(item => item.isDirectory() && !item.name.startsWith('.')).slice(0, 256);
  const checked = await Promise.all(candidates.map(async item => {
    const file = path.join(directory, item.name);
    const info = await stat(file).catch(() => undefined);
    return { file, modified: info?.mtimeMs ?? 0 };
  }));
  checked.sort((a, b) => b.modified - a.modified);
  return checked.slice(0, limit).map(item => item.file);
}

function selectedProjects(entries) {
  return entries.slice(0, maxSelected).map(item => typeof item === 'string' ? { cwd: item } : item)
    .filter(item => typeof item?.cwd === 'string' && path.isAbsolute(item.cwd));
}

function sourceConfigPath(config) {
  return config.configFile ?? config.file ?? process.env.DSH_AGENT_BRIDGE_CONFIG
    ?? (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'agent-bridge.json')
      : config.home ? path.join(config.home, '.dsh', 'agent-bridge.json') : undefined);
}

async function watchPlan(config, selected) {
  const wanted = new Map();
  function add(directory, matcher, priority = 1) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) return;
    const key = fileKey(directory);
    const current = wanted.get(key);
    if (current) {
      current.matchers.push(matcher);
      current.priority = Math.min(current.priority, priority);
    } else wanted.set(key, { directory, matchers: [matcher], priority });
  }
  function file(value, sqlite = false) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return;
    const name = path.basename(value);
    add(path.dirname(value), sqlite ? named(name, `${name}-wal`, `${name}-journal`) : named(name), 0);
  }
  async function skills(root, priority) {
    add(root, all, priority);
    const children = await recentDirectories(root, 20);
    for (const child of children) add(child, matches(skill), priority + 1);
    const system = path.join(root, '.system');
    add(system, all, priority + 1);
    for (const child of await recentDirectories(system, 8)) add(child, matches(skill), priority + 1);
  }
  async function childTranscripts(root, extra = []) {
    add(root, all);
    for (const child of await recentDirectories(root, 8)) {
      add(child, name => transcript.test(name) || name.endsWith('-session.json') || extra.includes(name), 2);
      for (const name of extra) {
        if (name === 'chats' || name === 'chatSessions') add(path.join(child, name), matches(/\.jsonl?$/i), 2);
      }
    }
  }
  function codexTranscripts(root) {
    add(root, all);
    const now = new Date();
    const days = new Set();
    for (const value of [now, new Date(now.valueOf() - 86_400_000)]) {
      const local = [value.getFullYear(), value.getMonth() + 1, value.getDate()].map(item => String(item).padStart(2, '0')).join('/');
      days.add(local);
      days.add(value.toISOString().slice(0, 10).replaceAll('-', '/'));
    }
    for (const day of days) {
      const directory = path.join(root, day);
      add(path.dirname(directory), all, 2);
      add(directory, matches(transcript), 2);
    }
  }

  const jobs = [];
  file(sourceConfigPath(config));
  for (const archive of config.archiveFiles ?? []) file(archive, true);
  for (const project of selected) {
    const { cwd } = project;
    add(cwd, name => /^(?:agents|claude|gemini|qwen|memory)\.md$/i.test(name) || name === '.agent-bridge' || projectFolders.includes(name), 0);
    const bridge = path.join(cwd, '.agent-bridge');
    add(bridge, named('memory', 'handoffs'), 0);
    for (const folder of ['memory', 'handoffs']) add(path.join(bridge, folder), matches(note), 0);
    for (const folder of projectFolders) {
      const root = path.join(cwd, folder);
      add(root, name => note.test(name) || name === 'memory' || name === 'skills', 0);
      add(path.join(root, 'memory'), matches(note), 0);
      jobs.push(skills(path.join(root, 'skills'), 0));
    }
    for (const [workspace, sources] of Object.entries(config.memoryExports ?? {})) {
      if (fileKey(workspace) !== fileKey(cwd)) continue;
      for (const source of sources) {
        if (note.test(source)) file(source);
        else add(source, matches(note), 0);
      }
    }
    for (const root of config.workspaceHubRoots ?? []) {
      for (const id of (project.projectIds ?? []).filter(value => /^P\d{3,}$/.test(value)).slice(0, 8)) {
        const folder = path.join(root, '项目档案', id);
        add(folder, name => note.test(name) || name === 'project.yaml' || hubFolders.includes(name), 0);
        for (const subfolder of hubFolders) add(path.join(folder, subfolder), matches(note), 0);
      }
    }
  }
  for (const root of config.workspaceHubRoots ?? []) {
    const projects = path.basename(root) === '项目档案' ? root : path.join(root, '项目档案');
    add(projects, matches(/^P\d{3,}$/), 0);
    jobs.push(skills(path.join(root, 'skills', 'source'), 2));
  }
  for (const root of config.projectRoots ?? []) {
    if (typeof root === 'string' && path.isAbsolute(root)) add(path.dirname(root), named(path.basename(root)), 0);
  }

  const globalSkills = [...(config.skillRoots ?? []), ...(config.opencodeSkillRoots ?? []).map(root => path.join(root, 'skills'))];
  if (config.home) globalSkills.push(path.join(config.home, '.agents', 'skills'));
  for (const root of globalSkills) jobs.push(skills(root, 2));

  for (const [provider, roots] of Object.entries(config.agentRoots ?? {})) {
    const agent = aliases[provider] ?? provider;
    for (const root of roots.slice(0, maxRootsPerAgent)) {
      if (agent === 'opencode' && (await stat(root).catch(() => undefined))?.isFile()) {
        file(root, true);
        continue;
      }
      add(root, name => /^(?:state_\d+\.sqlite(?:-wal|-journal)?|(?:opencode|conversation_summaries)\.db(?:-wal|-journal)?|history\.jsonl|session_index\.jsonl)$/i.test(name)
        || note.test(name) || ['projects', 'sessions', 'archived_sessions', 'workspaceStorage', 'User', 'tmp', 'skills', 'memory', 'memories', 'memories_v2', 'agent-memory', 'knowledge', 'qoder-knowledge', 'diary'].includes(name), 0);

      if (agent === 'codex') {
        const tail = path.basename(root).toLowerCase();
        if (tail !== 'archived_sessions') codexTranscripts(tail === 'sessions' ? root : path.join(root, 'sessions'));
        if (tail !== 'sessions') add(tail === 'archived_sessions' ? root : path.join(root, 'archived_sessions'), matches(transcript));
      }
      if (['claude', 'qoder', 'qwen', 'workbuddy'].includes(agent)) {
        const projects = path.basename(root).toLowerCase() === 'projects' ? root : path.join(root, 'projects');
        jobs.push(childTranscripts(projects));
        for (const { cwd } of selected) {
          const slug = cwd.replace(/[^\p{L}\p{N}]/gu, '-');
          const asciiSlug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
          for (const name of new Set([slug, asciiSlug, slug.toLowerCase()])) {
            const bucket = path.join(projects, name);
            add(bucket, name => transcript.test(name) || name === 'memory', 0);
            add(path.join(bucket, 'memory'), matches(note), 0);
          }
        }
      }
      if (agent === 'gemini') jobs.push(childTranscripts(path.basename(root) === 'tmp' ? root : path.join(root, 'tmp'), ['chats', '.project_root']));
      if (agent === 'opencode') {
        file(path.join(root, 'opencode.db'), true);
        file(path.join(root, 'opencode', 'opencode.db'), true);
      }
      if (agent === 'copilot' || agent === 'trae') {
        const stores = path.basename(root).toLowerCase() === 'workspacestorage'
          ? [root] : [path.join(root, 'workspaceStorage'), path.join(root, 'User', 'workspaceStorage')];
        for (const store of stores) jobs.push(childTranscripts(store, ['workspace.json', 'chatSessions']));
      }
      for (const folder of ['memory', 'memories', 'memories_v2', 'agent-memory', 'knowledge', 'qoder-knowledge', 'diary']) {
        add(path.join(root, folder), matches(note), 2);
      }
      if (agent === 'codex') {
        for (const folder of ['memories', 'memories_v2']) add(path.join(root, folder, 'extensions', 'ad_hoc', 'notes'), matches(note), 2);
      }
      jobs.push(skills(path.join(root, 'skills'), 2));
    }
  }
  await Promise.all(jobs);
  return [...wanted.values()].sort((a, b) => a.priority - b.priority);
}

async function watchTarget(entry) {
  let { directory, matchers } = entry;
  for (let level = 0; level < 4; level++) {
    try {
      const actual = await realpath(directory);
      const info = await stat(actual, { bigint: true });
      if (!info.isDirectory()) return undefined;
      return { directory: actual, matchers, identity: `${info.dev}:${info.ino}` };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return undefined;
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      matchers = [named(path.basename(directory))];
      directory = parent;
    }
  }
  return undefined;
}

export function createSourceMonitor({ onChange, debounceMs = 300 } = {}) {
  const watchers = new Map();
  let disposed = false;
  let dirty = true;
  let nextPlan = 0;
  let signature;
  let generation = 0;
  let changeTimer;

  function signal(event) {
    if (disposed) return;
    if (event === 'rename') dirty = true;
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = undefined;
      if (!disposed) onChange?.();
    }, debounceMs);
    changeTimer.unref?.();
  }

  async function update(config = {}, projectDirectories = []) {
    if (disposed) return;
    const selected = selectedProjects(projectDirectories);
    const current = JSON.stringify([config, selected]);
    if (!dirty && signature === current && Date.now() < nextPlan) return;
    const token = ++generation;
    signature = current;
    dirty = false;
    nextPlan = Date.now() + planLifetime;
    const plan = await watchPlan(config, selected);
    const wanted = new Map();
    for (let offset = 0; offset < plan.length && wanted.size < maxWatchers; offset += 48) {
      const chunk = await Promise.all(plan.slice(offset, offset + 48).map(watchTarget));
      for (const target of chunk) {
        if (!target) continue;
        const key = fileKey(target.directory);
        const current = wanted.get(key);
        if (current) current.matchers.push(...target.matchers);
        else if (wanted.size < maxWatchers) wanted.set(key, target);
      }
    }
    if (disposed || token !== generation) return;
    for (const [key, entry] of watchers) {
      if (wanted.has(key)) continue;
      entry.watcher.close();
      watchers.delete(key);
    }
    for (const [key, target] of wanted) {
      const current = watchers.get(key);
      if (current?.identity === target.identity) {
        current.matchers = target.matchers;
        continue;
      }
      if (current) {
        watchers.delete(key);
        current.watcher.close();
      }
      try {
        const entry = { matchers: target.matchers, identity: target.identity };
        const watcher = watch(target.directory, { persistent: false }, (event, filename) => {
          if (!filename || entry.matchers.some(matcher => matcher(path.basename(String(filename))))) signal(event);
        });
        entry.watcher = watcher;
        watcher.on('error', () => {
          if (watchers.get(key) !== entry) return;
          watcher.close();
          watchers.delete(key);
          dirty = true;
        });
        watcher.on('close', () => {
          if (watchers.get(key) !== entry) return;
          watchers.delete(key);
          dirty = true;
        });
        watchers.set(key, entry);
      } catch {
        // Unsupported filesystems remain covered by the caller's periodic polling.
      }
    }
  }

  function dispose() {
    disposed = true;
    clearTimeout(changeTimer);
    for (const { watcher } of watchers.values()) watcher.close();
    watchers.clear();
  }

  return { update, dispose };
}
