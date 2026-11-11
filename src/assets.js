import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MAX_ASSET_BYTES = 96 * 1024;
const MAX_ASSETS_PER_ROOT = 320;
const proof = Symbol('asset location');
const sensitiveName = /(?:^|[._ -])(?:api[-_ ]?keys?|access[-_ ]?tokens?|auth|credentials?|passwords?|secrets?|oauth)(?:[._ -]|$)/i;
const hubFolders = ['决策', '经验', '资料', '交接', '笔记'];
const agentHomes = {
  antigravity: ['.gemini/antigravity', '.gemini/antigravity-cli'],
  claude: ['.claude'],
  codex: ['.codex'],
  dsh: ['.dsh'],
  gemini: ['.gemini'],
  opencode: ['.local/share/opencode'],
  qoder: ['.qoder-cn', '.qoder'],
  qwen: ['.qwen'],
  reasonix: ['.reasonix'],
  trae: ['.trae-cn', '.trae'],
  workbuddy: ['.workbuddy'],
};
const projectAgentFolders = {
  '.agent': 'antigravity',
  '.claude': 'claude',
  '.codex': 'codex',
  '.dsh': 'dsh',
  '.gemini': 'gemini',
  '.opencode': 'opencode',
  '.qoder': 'qoder',
  '.qwen': 'qwen',
  '.trae': 'trae',
  '.workbuddy': 'workbuddy',
};
const projectInstructions = {
  'AGENTS.md': 'shared',
  'CLAUDE.md': 'claude',
  'GEMINI.md': 'gemini',
  'QWEN.md': 'qwen',
  'MEMORY.md': 'shared',
};

function canonicalKey(file) {
  const normalized = path.normalize(file);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inside(root, file) {
  const relative = path.relative(canonicalKey(root), canonicalKey(file));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function directory(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file === path.parse(file).root) return null;
  try {
    const resolved = await realpath(file);
    return (await lstat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function children(root, child = '.') {
  try {
    const target = await realpath(path.join(root, child));
    if (!inside(root, target)) return [];
    const entries = await readdir(target, { withFileTypes: true });
    return entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_ASSETS_PER_ROOT);
  } catch {
    return [];
  }
}

async function located(file, root) {
  const resolved = await realpath(file);
  if (!inside(root, resolved) || canonicalKey(file) !== canonicalKey(resolved)) {
    throw new Error('Asset path changed or is outside its source root');
  }
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.nlink > 1n) throw new Error('Asset is not a regular, unlinked file');
  return info;
}

async function recordAsset(root, file, meta) {
  try {
    const info = await located(file, root);
    const revision = `${info.ino}:${info.mtimeNs}:${info.size}`;
    return { ...meta, file, revision, [proof]: { root, file, info } };
  } catch {
    return null;
  }
}

export async function readAsset(item) {
  const source = item?.[proof];
  if (!source || source.file !== item.file) throw new Error('Asset source is unavailable');
  const current = await located(source.file, source.root);
  if (!sameFile(source.info, current)) throw new Error('Asset changed since discovery');
  const handle = await open(source.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const confirmed = await located(source.file, source.root);
    if (!sameFile(current, opened) || !sameFile(opened, confirmed)) throw new Error('Asset changed while opening');
    const bytes = Buffer.alloc(MAX_ASSET_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const completed = await handle.stat({ bigint: true });
    if (opened.size !== completed.size || opened.mtimeNs !== completed.mtimeNs || opened.ctimeNs !== completed.ctimeNs) {
      throw new Error('Asset changed while reading');
    }
    const truncated = length > MAX_ASSET_BYTES;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.min(length, MAX_ASSET_BYTES)), {
      stream: truncated,
    });
    if (text.includes('\0')) throw new Error('Asset is not UTF-8 text');
    return { text, truncated };
  } finally {
    await handle.close();
  }
}

function agentId(value) {
  const label = String(value).toLowerCase().trim();
  if (label.startsWith('open-code')) return 'opencode';
  return Object.keys(agentHomes).find((agent) => label.startsWith(agent))
    ?? (label.startsWith('deepseek') ? 'dsh' : label);
}

function noteName(name) {
  return !name.startsWith('.') && /\.md$/i.test(name) && !sensitiveName.test(name);
}

async function addNote(items, root, relative, agent, scope, detail) {
  if (!noteName(path.basename(relative))) return;
  const note = await recordAsset(root, path.join(root, relative), {
    agent, scope, detail, name: path.basename(relative, path.extname(relative)),
  });
  if (note) items.push(note);
}

async function notesIn(items, root, folder, agent, scope, detail) {
  const entries = await children(root, folder);
  await Promise.all(entries.filter((entry) => entry.isFile() && noteName(entry.name)).map((entry) => (
    addNote(items, root, path.join(folder, entry.name), agent, scope, detail)
  )));
}

function registryPaths(text) {
  return [...text.matchAll(/^(?:canonicalPath:|\s+path:)[ \t]+([^\r\n]+)$/gm)].map((match) => {
    const value = match[1].trim();
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
    if (value.startsWith('"') && value.endsWith('"')) {
      try { return JSON.parse(value); } catch { return ''; }
    }
    return value;
  }).filter((value) => typeof value === 'string' && path.isAbsolute(value));
}

async function hubNotes(items, root, cwd, projectIds) {
  for (const id of projectIds.filter((value) => /^P\d{3,}$/.test(value))) {
    const folder = path.join('项目档案', id);
    const record = await recordAsset(root, path.join(root, folder, 'project.yaml'), {});
    if (!record) continue;
    try {
      const { text, truncated } = await readAsset(record);
      if (truncated) continue;
      const directories = await Promise.all(registryPaths(text).map(directory));
      if (!directories.some((directory) => directory && canonicalKey(directory) === canonicalKey(cwd))) continue;
    } catch {
      continue;
    }
    await Promise.all(['.', ...hubFolders].map((subfolder) => (
      notesIn(items, root, path.join(folder, subfolder), 'workspacehub', 'shared', `${id} · ${subfolder === '.' ? '项目记忆' : subfolder}`)
    )));
  }
}

async function exportedNotes(items, cwd, memoryExports) {
  await Promise.all(Object.entries(memoryExports ?? {}).map(async ([workspace, paths]) => {
    const projectRoot = await directory(workspace);
    if (!projectRoot || canonicalKey(projectRoot) !== canonicalKey(cwd)) return;
    await Promise.all(paths.map(async (source) => {
      if (typeof source !== 'string' || !path.isAbsolute(source)) return;
      const folder = await directory(source);
      if (folder) {
        await notesIn(items, folder, '.', 'export', 'project', '配置的记忆导出');
        return;
      }
      const parent = await directory(path.dirname(source));
      if (parent) await addNote(items, parent, path.basename(source), 'export', 'project', '配置的记忆导出');
    }));
  }));
}

async function nativeNotes(items, root, cwd, agent) {
  const globalFolders = {
    antigravity: ['knowledge'], claude: ['agent-memory'],
    codex: ['memories', 'memories_v2', 'memories/extensions/ad_hoc/notes', 'memories_v2/extensions/ad_hoc/notes'],
    dsh: ['diary'], opencode: ['memory'], qoder: ['memory', 'qoder-knowledge'], reasonix: ['memory/global'],
    trae: ['memory'], workbuddy: ['memory'],
  };
  for (const folder of globalFolders[agent] ?? []) {
    await notesIn(items, root, folder, agent, 'agent', '智能体记忆');
    if (agent === 'claude' || agent === 'antigravity') {
      const buckets = await children(root, folder);
      await Promise.all(buckets.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => (
        notesIn(items, root, path.join(folder, entry.name, agent === 'antigravity' ? 'artifacts' : ''), agent, 'agent', entry.name)
      )));
    }
  }
  const instructionFiles = {
    claude: ['CLAUDE.md'], codex: ['AGENTS.md'], dsh: ['AGENTS.md'], gemini: ['GEMINI.md'],
    opencode: ['AGENTS.md', 'MEMORY.md'], qwen: ['QWEN.md'], workbuddy: ['USER.md', 'SOUL.md', 'MEMORY.md'],
  };
  await Promise.all((instructionFiles[agent] ?? []).map((name) => addNote(items, root, name, agent, 'agent', '用户指引')));
  if (cwd && ['claude', 'qoder', 'qwen'].includes(agent)) {
    const slug = cwd.replace(/[^\p{L}\p{N}]/gu, '-');
    const asciiSlug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    for (const name of new Set([slug, asciiSlug, slug.toLowerCase()])) {
      await notesIn(items, root, path.join('projects', name, 'memory'), agent, 'project', '原生工作区记忆');
    }
  }
}

async function skillFolder(items, root, relative, agent, scope, linkedRoots, detail, includeSystem = true) {
  const entries = await children(root, relative);
  for (const entry of entries) {
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || (entry.name.startsWith('.') && entry.name !== '.system')) continue;
    const child = path.join(relative, entry.name);
    if (entry.name === '.system' && includeSystem && entry.isDirectory()) {
      await skillFolder(items, root, child, agent, scope, linkedRoots, detail, false);
      continue;
    }
    const target = await directory(path.join(root, child));
    const boundary = target && [root, ...linkedRoots].find((candidate) => inside(candidate, target));
    if (!boundary) continue;
    const item = await recordAsset(boundary, path.join(target, 'SKILL.md'), { name: entry.name, agent, scope, detail });
    if (item) items.push(item);
  }
}

async function cachedPluginSkills(items, root, agent) {
  const cache = 'plugins/cache';
  for (const market of (await children(root, cache)).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))) {
    const marketFolder = path.join(cache, market.name);
    const packages = (await children(root, marketFolder)).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    await Promise.all(packages.map(async (plugin) => {
      const packageFolder = path.join(marketFolder, plugin.name);
      const versions = (await children(root, packageFolder)).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
      versions.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      for (const version of versions) {
        const found = [];
        await skillFolder(found, root, path.join(packageFolder, version.name, 'skills'), agent, 'agent', [], `${plugin.name} · ${version.name} · 本地缓存`);
        if (found.length) {
          items.push(...found);
          break;
        }
      }
    }));
  }
}

function unique(items) {
  const indexed = new Map();
  for (const item of items) {
    const key = `${item.agent}:${item.scope}:${canonicalKey(item.file)}`;
    if (!indexed.has(key)) indexed.set(key, item);
  }
  return [...indexed.values()].sort((a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name));
}

export async function listProjectAssets(project, config = {}) {
  const home = config.home ?? homedir();
  const cwd = await directory(project.cwd);
  const hubs = (await Promise.all((config.workspaceHubRoots ?? []).map(directory))).filter(Boolean);
  const sharedCandidates = [
    path.join(home, '.agents/skills'), path.join(home, '.config/skillshare/skills'),
    path.join(home, '.skillshare/skills'), path.join(home, 'AppData/Roaming/skillshare/skills'),
    ...(config.skillRoots ?? []), ...hubs.map((root) => path.join(root, 'skills/source')),
  ];
  const sharedRoots = [...new Set((await Promise.all(sharedCandidates.map(directory))).filter(Boolean))];
  const agents = new Set((project.agents ?? []).map(agentId));
  const configured = Object.entries(config.agentRoots ?? {});
  const memories = [];
  const skills = [];

  if (cwd) {
    const instructions = Object.entries(projectInstructions).map(([file, agent]) => addNote(memories, cwd, file, agent, 'project', '项目指引'));
    const folders = Object.entries(projectAgentFolders).map(async ([folder, agent]) => {
      await Promise.all([
        notesIn(memories, cwd, path.join(folder, 'memory'), agent, 'project', '项目记忆'),
        ...Object.entries(projectInstructions).filter(([, owner]) => owner === agent).map(([file]) => (
          addNote(memories, cwd, path.join(folder, file), agent, 'project', '项目指引')
        )),
        skillFolder(skills, cwd, path.join(folder, 'skills'), agent, 'project', sharedRoots, '项目 Skill'),
      ]);
    });
    await Promise.all([
      ...instructions, ...folders,
      notesIn(memories, cwd, '.agent-bridge/memory', 'shared', 'project', '项目共享记忆'),
      notesIn(memories, cwd, '.agent-bridge/handoffs', 'shared', 'project', '项目交接'),
      ...hubs.map((root) => hubNotes(memories, root, cwd, project.projectIds ?? [])),
      exportedNotes(memories, cwd, config.memoryExports),
      ...['.agents/skills', '.skillshare/skills', 'skills'].map((folder) => (
        skillFolder(skills, cwd, folder, 'shared', 'project', sharedRoots, '项目 Skill')
      )),
    ]);
  }

  await Promise.all([
    ...sharedRoots.map((root) => skillFolder(skills, root, '.', 'shared', 'shared', sharedRoots, '共享 Skill')),
    ...[...agents].map(async (agent) => {
      const overrides = configured.filter(([name]) => agentId(name) === agent);
      const candidates = overrides.length
        ? overrides.flatMap(([, roots]) => roots)
        : (agentHomes[agent] ?? []).map((folder) => path.join(home, folder));
      const roots = [...new Set((await Promise.all(candidates.map(directory))).filter(Boolean))];
      if (agent === 'opencode') {
        const configDirs = config.opencodeSkillRoots ?? [path.join(home, '.config/opencode')];
        const configRoots = (await Promise.all(configDirs.map(directory))).filter(Boolean);
        const memoryRoots = [...new Set([...roots, ...configRoots])];
        const skillRoots = config.opencodeSkillRoots === undefined ? memoryRoots : [...new Set(configRoots)];
        await Promise.all([
          ...memoryRoots.map((root) => nativeNotes(memories, root, cwd, agent)),
          ...skillRoots.flatMap((root) => ['skills', 'skill'].map((folder) => (
            skillFolder(skills, root, folder, agent, 'agent', sharedRoots, '智能体 Skill')
          ))),
        ]);
        return;
      }
      await Promise.all(roots.flatMap((root) => [
        nativeNotes(memories, root, cwd, agent),
        skillFolder(skills, root, 'skills', agent, 'agent', sharedRoots, '智能体 Skill'),
        ...(['claude', 'codex'].includes(agent) ? [cachedPluginSkills(skills, root, agent)] : []),
      ]));
    }),
  ]);
  return { memories: unique(memories), skills: unique(skills) };
}
