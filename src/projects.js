import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const maxSessions = 8_000;
const maxMessages = 36;
const maxMessageLength = 4_000;
const maxTranscriptBytes = 12 * 1024 * 1024;
const maxTranscriptRowBytes = 256 * 1024;
const tailBufferBytes = maxTranscriptBytes + 1;
const transcriptHeaderBytes = 96 * 1024;
const codexLocations = ['sessions', 'archived_sessions'];
const jsonlFile = /\.jsonl$/i;
const compressedCodexFile = /\.jsonl\.zst$/i;
const hasZstd = typeof zlib.createZstdDecompress === 'function';
const conversationLimits = { messages: 600, characters: 160_000, messageLength: 24_000 };
const traceItemLimit = 600;
const traceTextLimit = 8_000;

const agentLabels = {
  codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', workbuddy: 'WorkBuddy',
  qoder: 'Qoder', trae: 'TRAE', antigravity: 'Antigravity', gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot', qwen: 'Qwen Code',
};

function configuredRoots(config, agent) {
  const aliases = {
    antigravity: ['antigravity-cli'], claude: ['claude-code'], codex: ['codex-cli'],
    copilot: ['vscode', 'vscode-copilot', 'vscode-insiders', 'vscodium', 'code-oss'],
    gemini: ['gemini-cli'], opencode: ['open-code'], qoder: ['qoder-cn'],
    qwen: ['qwen-code'], trae: ['trae-cn', 'trae-solo'],
  };
  const roots = config.agentRoots ?? {};
  const keys = [agent, ...(aliases[agent] ?? [])];
  if (keys.some(key => Object.hasOwn(roots, key))) return keys.flatMap(key => roots[key] ?? []);
  if (!config.home) return [];
  const defaults = {
    codex: ['.codex'], claude: ['.claude'], opencode: ['.local/share/opencode'],
    qoder: ['.qoder-cn', '.qoder'], workbuddy: ['.workbuddy'],
    trae: ['.trae-cn'],
    antigravity: ['.gemini/antigravity', '.gemini/antigravity-cli'], gemini: ['.gemini'],
    qwen: ['.qwen'],
  };
  return (defaults[agent] ?? []).map(root => path.join(config.home, root));
}

function pathKey(file) {
  const normalized = path.normalize(file).replace(/^\\\\\?\\/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function physicalPath(file) {
  return realpath(file).catch(() => undefined);
}

function inside(root, file) {
  const relative = path.relative(pathKey(root), pathKey(file));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function scopedFile(file, root) {
  const [actual, base] = await Promise.all([physicalPath(file), physicalPath(root)]);
  return actual && base && inside(base, actual) ? actual : undefined;
}

async function prefix(file, bytes) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { text: '', truncated: false };
    const buffer = Buffer.alloc(Math.min(info.size, bytes));
    const result = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.toString('utf8', 0, result.bytesRead), truncated: info.size > result.bytesRead, modified: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

function json(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function rowsFrom(text, truncated) {
  const value = text.replace(/^\uFEFF/, '');
  const end = truncated ? value.lastIndexOf('\n') + 1 : value.length;
  return value.slice(0, end).split(/\r?\n/).map(json).filter(Boolean);
}

async function directories(root) {
  return readdir(root, { withFileTypes: true });
}

function missingStore() {
  return Object.assign(new Error('未发现可读取的本地数据目录'), { code: 'ENOENT' });
}

async function dataDirectories(root, relatives) {
  const candidates = await Promise.all(relatives.map(relative => scopedFile(path.join(root, relative), root)));
  const found = await Promise.all(candidates.filter(Boolean).map(async candidate => (await stat(candidate)).isDirectory() ? candidate : undefined));
  return [...new Set(found.filter(Boolean))];
}

function yamlScalar(value) {
  const text = value.trim();
  if (text.startsWith('"')) return json(text) ?? '';
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text.replace(/\s+#.*$/, '');
}

// WorkspaceHub emits a fixed, flat schema for project metadata and its root list.
function projectRecord(text) {
  const record = { roots: [], agentIDs: [] };
  let section;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const top = /^([A-Za-z][\w]*):\s*(.*)$/.exec(line);
    if (top) {
      section = top[1];
      if (['id', 'name', 'canonicalPath', 'entryKind'].includes(section)) record[section] = yamlScalar(top[2]);
      if (section === 'agentIDs' && top[2].startsWith('[') && top[2].endsWith(']')) {
        record.agentIDs = top[2].slice(1, -1).split(',').map(yamlScalar).filter(Boolean);
      }
      continue;
    }
    if (section === 'agentIDs') {
      const entry = /^\s*-\s+(.+)$/.exec(line);
      if (entry) record.agentIDs.push(yamlScalar(entry[1]));
    }
    if (section === 'roots') {
      const entry = /^\s*-\s+id:\s*(.*)$/.exec(line);
      if (entry) record.roots.push({ id: yamlScalar(entry[1]) });
      const field = /^\s+(role|path):\s*(.*)$/.exec(line);
      if (field && record.roots.length) record.roots.at(-1)[field[1]] = yamlScalar(field[2]);
    }
  }
  return record;
}

async function workspaceProjects(root) {
  const result = [];
  const records = path.basename(root) === '项目档案' ? root : path.join(root, '项目档案');
  for (const entry of await directories(records)) {
    if (!entry.isDirectory() || !/^P\d{3,}$/.test(entry.name)) continue;
    const file = await scopedFile(path.join(records, entry.name, 'project.yaml'), records);
    if (!file) continue;
    const { text, truncated } = await prefix(file, 256 * 1024);
    if (truncated) continue;
    const record = projectRecord(text);
    if (record.id !== entry.name || typeof record.canonicalPath !== 'string' || !path.isAbsolute(record.canonicalPath)) continue;
    const locations = [record.canonicalPath, ...record.roots.filter(item => item.role === 'auxiliary').map(item => item.path)];
    for (const location of locations) {
      if (!location || !path.isAbsolute(location)) continue;
      // A file project opens its containing directory, the nearest valid DSH cwd.
      const info = await stat(location).catch(() => undefined);
      const cwd = info?.isFile() ? path.dirname(location) : location;
      for (const agent of record.agentIDs.length ? record.agentIDs : ['workspacehub']) {
        result.push({ cwd, agent, name: record.name, projectId: record.id, projectRoot: root });
      }
    }
  }
  return result;
}

async function withDatabase(file, callback) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    return callback(db);
  } finally {
    db.close();
  }
}

function columns(db, table) {
  return new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => row.name));
}

async function archivedProjects(file) {
  return withDatabase(file, db => {
    const fields = columns(db, 'sessions');
    if (!['id', 'cwd', 'agent'].every(field => fields.has(field))) throw new Error('未识别 AgentsView 会话表');
    const sort = fields.has('ended_at') ? 'ended_at' : 'id';
    const deleted = fields.has('deleted_at') ? ' AND deleted_at IS NULL' : '';
    const machine = fields.has('machine') ? " AND machine IN ('', 'local')" : '';
    const title = fields.has('title') ? 'substr(title, 1, 200)' : 'NULL';
    return db.prepare(`SELECT id, cwd, agent, ${sort} AS date, ${title} AS title FROM sessions WHERE cwd <> ''${deleted}${machine} ORDER BY ${sort} DESC LIMIT ?`)
      .all(maxSessions).map(({ id, cwd, agent, date, title }) => ({ cwd, agent, archive: { kind: 'agentsview', agent, file, id, date, title } }));
  });
}

async function codexProjects(root) {
  const entries = await directories(root);
  const states = entries.filter(entry => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name));
  states.sort((a, b) => Number(b.name.match(/\d+/)[0]) - Number(a.name.match(/\d+/)[0]));
  let indexed;
  let indexError;
  for (const entry of states) {
    const file = await scopedFile(path.join(root, entry.name), root);
    if (!file) continue;
    try {
      indexed = await withDatabase(file, db => {
        const fields = columns(db, 'threads');
        if (!['cwd', 'rollout_path', 'id'].every(field => fields.has(field))) return undefined;
        const sort = fields.has('updated_at') ? 'updated_at' : 'id';
        const title = fields.has('title') ? 'substr(title, 1, 200)' : 'NULL';
        return db.prepare(`SELECT id, cwd, rollout_path, ${sort} AS date, ${title} AS title FROM threads WHERE cwd <> '' ORDER BY ${sort} DESC LIMIT ?`).all(maxSessions);
      });
      if (indexed) break;
    } catch (error) {
      indexError = error;
    }
  }
  const bases = await transcriptDirectories(root, codexLocations);
  if (!bases.length) throw indexError ?? missingStore();
  const byFile = new Map();
  for (let offset = 0; offset < (indexed?.length ?? 0); offset += 32) {
    const batch = await Promise.all(indexed.slice(offset, offset + 32).map(async ({ id, cwd, rollout_path, date, title }) => {
      const file = await resolveCodexTranscript(rollout_path, bases);
      return file ? { cwd, agent: 'codex', archive: { kind: 'codex', file, root, id, date, title } } : undefined;
    }));
    for (const project of batch.filter(Boolean)) {
      const key = pathKey(project.archive.file);
      if (!byFile.has(key)) byFile.set(key, project);
    }
  }
  // Files may be compressed or moved before SQLite catches up. Keep SQLite's
  // titles when its path resolves, and discover compressed files independently.
  const byId = new Set([...byFile.values()].map(project => project.archive.id).filter(Boolean));
  const include = file => !byFile.has(pathKey(file))
    && ((!indexed?.length && jsonlFile.test(file)) || (hasZstd && compressedCodexFile.test(file)));
  const fallback = await scanJsonlProjects(root, 'codex', bases, 4, include, maxSessions - byFile.size);
  for (const project of fallback) {
    const { file, id } = project.archive;
    if (id && byId.has(id)) continue;
    if (id) byId.add(id);
    byFile.set(pathKey(file), project);
  }
  return [...byFile.values()];
}

async function resolveCodexTranscript(file, bases) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return undefined;
  const candidates = compressedCodexFile.test(file) ? [file, file.slice(0, -4)]
    : jsonlFile.test(file) ? [file, file + '.zst'] : [];
  for (const candidate of candidates) {
    const actual = await physicalPath(candidate);
    if (!actual || !bases.some(base => inside(base, actual))
      || !(jsonlFile.test(actual) || hasZstd && compressedCodexFile.test(actual))) continue;
    if ((await stat(actual).catch(() => undefined))?.isFile()) return actual;
  }
}

function opencodeTables(db) {
  return ['session_v2', 'session'].filter(table => {
    const fields = columns(db, table);
    return ['id', 'directory', 'time_updated'].every(field => fields.has(field));
  });
}

async function opencodeProjects(root) {
  const file = await opencodeDatabase(root);
  if (!file) throw missingStore();
  return withDatabase(file, db => {
    const tables = opencodeTables(db);
    if (!tables.length) throw new Error('未识别 OpenCode 会话表');
    const projects = tables.flatMap(table => {
      const title = columns(db, table).has('title') ? 'substr(title, 1, 200)' : 'NULL';
      return db.prepare(`SELECT id, directory AS cwd, time_updated AS date, ${title} AS title FROM ${table} WHERE directory <> '' ORDER BY time_updated DESC LIMIT ?`)
        .all(maxSessions).map(({ id, cwd, date, title }) => ({ cwd, agent: 'opencode', archive: { kind: 'opencode', file, id, table, date, title } }));
    });
    const fields = columns(db, 'project');
    if (fields.has('worktree')) {
      const name = fields.has('name') ? 'name' : 'NULL';
      projects.push(...db.prepare(`SELECT worktree AS cwd, ${name} AS name FROM project WHERE worktree <> '' LIMIT ?`).all(maxSessions)
        .map(row => ({ ...row, agent: 'opencode' })));
    }
    return projects;
  });
}

async function opencodeDatabase(root) {
  const info = await stat(root).catch(() => undefined);
  if (info?.isFile()) return physicalPath(root);
  if (!info?.isDirectory()) return undefined;
  for (const relative of ['opencode.db', 'opencode/opencode.db']) {
    const candidate = await scopedFile(path.join(root, relative), root);
    if (candidate && (await stat(candidate)).isFile()) return candidate;
  }
  return undefined;
}

async function transcriptFiles(root, depth, limit, predicate) {
  const files = [];
  const stack = [{ root, depth }];
  while (stack.length && files.length < limit) {
    const current = stack.pop();
    const entries = await directories(current.root).catch(() => []);
    for (const entry of entries) {
      const file = path.join(current.root, entry.name);
      if (entry.isFile() && predicate(entry.name, file)) files.push(file);
      if (files.length >= limit) break;
      if (entry.isDirectory() && current.depth > 0 && entry.name !== 'subagents') {
        stack.push({ root: file, depth: current.depth - 1 });
      }
    }
  }
  return files;
}

async function nativeCwd(file, agent, rows) {
  if (agent === 'codex') return rows.find(row => row.type === 'session_meta')?.payload?.cwd;
  const cwd = rows.find(row => typeof row.cwd === 'string' && path.isAbsolute(row.cwd))?.cwd;
  if (cwd || agent !== 'qoder') return cwd;
  const sidecar = await scopedFile(file.replace(/\.jsonl$/i, '-session.json'), path.dirname(file));
  if (!sidecar) return undefined;
  const { text, truncated } = await prefix(sidecar, 128 * 1024);
  const metadata = truncated ? undefined : json(text);
  return metadata?.working_dir ?? metadata?.workingDir ?? metadata?.cwd;
}

async function jsonlProjects(root, agent, children = ['projects'], depth = 1) {
  const roots = await transcriptDirectories(root, children);
  if (!roots.length) throw missingStore();
  return scanJsonlProjects(root, agent, roots, depth, file => jsonlFile.test(file));
}

async function scanJsonlProjects(root, agent, roots, depth, include, limit = maxSessions) {
  const files = [];
  for (const target of roots) {
    files.push(...await transcriptFiles(target, depth, limit - files.length, (_name, file) => include(file)));
  }
  const result = [];
  for (let offset = 0; offset < files.length; offset += 32) {
    const batch = await Promise.all(files.slice(offset, offset + 32).map(async file => {
      try {
        const compressed = agent === 'codex' && compressedCodexFile.test(file);
        const { text, truncated, modified } = compressed ? await compressedPrefix(file) : await prefix(file, transcriptHeaderBytes);
        const rows = rowsFrom(text, truncated);
        const cwd = await nativeCwd(file, agent, rows);
        const id = agent === 'codex' ? rows.find(row => row.type === 'session_meta')?.payload?.id : undefined;
        const title = rows.findLast(row => row.type === 'custom-title' && typeof row.customTitle === 'string')?.customTitle
          ?? rows.findLast(row => row.type === 'summary' && typeof row.summary === 'string')?.summary
          ?? firstQuestion(rows, agent);
        return cwd ? { cwd, agent, archive: { kind: agent, file, root, id, date: modified, title: title?.slice(0, 200) } } : undefined;
      } catch { return undefined; }
    }));
    result.push(...batch.filter(Boolean));
  }
  return result;
}

function transcriptDirectories(root, children) {
  return dataDirectories(root, children.includes(path.basename(root).toLowerCase()) ? [''] : children);
}

function editorStores(root) {
  const relatives = path.basename(root).toLowerCase() === 'workspacestorage'
    ? [''] : ['workspaceStorage', 'User/workspaceStorage'];
  return dataDirectories(root, relatives);
}

async function editorProjects(root, agent) {
  const stores = await editorStores(root);
  if (!stores.length) throw missingStore();
  const files = [];
  for (const store of stores) {
    files.push(...await transcriptFiles(store, 1, maxSessions - files.length, name => name === 'workspace.json'));
  }
  const result = [];
  for (const file of files) {
    try {
      const { text } = await prefix(file, 32 * 1024);
      const value = json(text);
      const cwd = localDirectory(value?.folder);
      if (!cwd) continue;
      result.push({ cwd, agent });
      if (agent !== 'copilot') continue;
      const sessions = await transcriptFiles(path.join(path.dirname(file), 'chatSessions'), 0, maxSessions, name => /\.jsonl?$/i.test(name));
      for (const session of sessions) {
        const info = await stat(session).catch(() => undefined);
        if (info) result.push({ cwd, agent, archive: { kind: 'copilot', file: session, root, date: info.mtimeMs } });
      }
    } catch { continue; }
  }
  return result;
}

async function geminiProjects(root) {
  const [base] = await transcriptDirectories(root, ['tmp']);
  if (!base) throw missingStore();
  const files = await transcriptFiles(base, 1, maxSessions, name => name === '.project_root');
  const result = [];
  for (const file of files) {
    const { text } = await prefix(file, 32 * 1024);
    const cwd = text.trim();
    result.push({ cwd, agent: 'gemini' });
    const sessions = await transcriptFiles(path.join(path.dirname(file), 'chats'), 0, maxSessions, name => /^session-.+\.jsonl?$/i.test(name));
    for (const session of sessions) {
      const info = await stat(session).catch(() => undefined);
      if (info) result.push({ cwd, agent: 'gemini', archive: { kind: 'gemini', file: session, root, date: info.mtimeMs } });
    }
  }
  return result;
}

function localDirectory(value) {
  if (typeof value !== 'string') return undefined;
  if (path.isAbsolute(value)) return value;
  if (!value.startsWith('file:')) return undefined;
  try { return fileURLToPath(value); } catch { return undefined; }
}

async function antigravityProjects(root) {
  await directories(root);
  const projects = [];
  const database = await scopedFile(path.join(root, 'conversation_summaries.db'), root);
  const file = await scopedFile(path.join(root, 'history.jsonl'), root);
  if (!database && !file) throw missingStore();
  if (database) {
    const rows = await withDatabase(database, db => {
      const fields = columns(db, 'conversation_summaries');
      if (!fields.has('workspace_uris')) return [];
      return db.prepare("SELECT workspace_uris FROM conversation_summaries WHERE workspace_uris NOT IN ('', '[]') LIMIT ?").all(maxSessions);
    });
    for (const row of rows) {
      const uris = json(row.workspace_uris);
      if (!Array.isArray(uris)) continue;
      for (const uri of uris) {
        const cwd = localDirectory(uri);
        if (cwd) projects.push({ cwd, agent: 'antigravity' });
      }
    }
  }
  if (file) {
    const { text, truncated } = await prefix(file, maxTranscriptBytes);
    for (const row of rowsFrom(text, truncated)) {
      const cwd = localDirectory(row.workspace);
      if (cwd && typeof row.conversationId === 'string') {
        projects.push({ cwd, agent: 'antigravity', archive: { kind: 'antigravity', file, root, id: row.conversationId, date: row.timestamp } });
      }
    }
  }
  return projects;
}

export async function scanProjects(config) {
  const projects = [];
  const sources = [];
  const discovered = new Map();
  async function scan(id, label, paths, load, partial) {
    let errors = 0;
    const checks = await Promise.all(paths.map(async value => {
      try { return await realpath(value); } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') errors++;
        return undefined;
      }
    }));
    const candidates = [...new Set(checks.filter(Boolean))];
    let succeeded = 0;
    let found = 0;
    for (const file of candidates) {
      try {
        const rows = await load(file);
        projects.push(...rows);
        found += rows.length;
        succeeded++;
      } catch (error) {
        if (error.code !== 'ENOENT') errors++;
      }
    }
    const status = succeeded ? (errors || partial ? 'partial' : 'ready') : errors ? 'error' : candidates.length ? 'partial' : 'unavailable';
    const detail = succeeded ? `${found} 条项目来源记录${partial ? ` · ${partial}` : ''}${errors ? ' · 部分来源读取失败' : ''}`
      : errors ? '本地来源无法读取或格式无法识别' : candidates.length ? '已找到数据目录，尚无可读取的项目来源' : undefined;
    sources.push({ id, label, status, detail });
  }

  await Promise.all([
    scan('workspacehub', 'Agent Workspace Manager', config.workspaceHubRoots ?? [], workspaceProjects),
    scan('agentsview', 'AgentsView 会话归档', config.archiveFiles ?? [], archivedProjects),
    ...Object.entries({
      codex: codexProjects, claude: root => jsonlProjects(root, 'claude'),
      opencode: opencodeProjects, workbuddy: root => jsonlProjects(root, 'workbuddy'),
      qoder: root => jsonlProjects(root, 'qoder'), qwen: root => jsonlProjects(root, 'qwen', ['projects'], 2),
      trae: root => editorProjects(root, 'trae'), copilot: root => editorProjects(root, 'copilot'),
      gemini: geminiProjects,
      antigravity: antigravityProjects,
    }).map(([agent, load]) => scan(agent, agentLabels[agent], configuredRoots(config, agent), load, {
      trae: '支持工作区元数据；会话可从 AgentsView 读取已归档部分',
      copilot: '支持 VS Code 工作区会话；其他版本可从 AgentsView 读取已归档部分',
      antigravity: '支持工作区元数据和 CLI 提示记录；完整会话可从 AgentsView 读取已归档部分',
    }[agent])),
  ]);

  for (const cwd of config.projectRoots ?? []) projects.push({ cwd, agent: 'manual' });
  const canonical = new Map();
  for (const project of projects) {
    if (typeof project.cwd !== 'string' || !path.isAbsolute(project.cwd) || project.cwd === path.parse(project.cwd).root) continue;
    const key = pathKey(project.cwd);
    if (!canonical.has(key)) canonical.set(key, await physicalPath(project.cwd) ?? path.normalize(project.cwd));
    project.cwd = canonical.get(key);
    const timestamp = dateMillis(project.archive?.date);
    if (timestamp > 0 && timestamp < 8_640_000_000_000_000) project.updatedAt = new Date(timestamp).toISOString();
    const identity = JSON.stringify([pathKey(project.cwd), project.agent, project.projectId, project.archive?.kind, project.archive?.file, project.archive?.id]);
    const previous = discovered.get(identity);
    if (!previous || compareDate(project.archive?.date, previous.archive?.date) > 0) discovered.set(identity, project);
  }
  return { projects: [...discovered.values()], sources: sources.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function dateMillis(value) {
  if (typeof value === 'string') return Date.parse(value) || 0;
  if (!Number.isFinite(value) || value <= 0 || value > 8_640_000_000_000_000) return 0;
  return Math.trunc(value < 10_000_000_000 ? value * 1_000 : value);
}

function compareDate(a, b) {
  return dateMillis(a) - dateMillis(b);
}

async function sameDirectory(cwd, expected) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  const actual = await physicalPath(cwd);
  return pathKey(actual ?? cwd) === pathKey(expected);
}

function stripRuntimeWrapper(text) {
  let value = text.trimStart();
  let stripped = false;
  while (value.startsWith('<') || value.startsWith('#')) {
    const wrapper = /^<(environment_context|permissions instructions|collaboration_mode|system-reminder|developer_instructions|user_instructions|app-context|subagent_notification)(?=[>\s])[^>]*(?:>|$)/i.exec(value);
    const instructions = wrapper ? undefined : /^# AGENTS\.md instructions for [\s\S]*?\n<INSTRUCTIONS>/i.exec(value);
    if (!wrapper && !instructions) break;
    const closing = `</${wrapper?.[1].toLowerCase() ?? 'instructions'}>`;
    const end = value.toLowerCase().indexOf(closing, (wrapper ?? instructions)[0].length);
    if (end === -1) return '';
    value = value.slice(end + closing.length).trimStart();
    stripped = true;
  }
  return stripped ? value : text;
}

function messageText(text) {
  return typeof text === 'string' ? stripRuntimeWrapper(text).trim() : '';
}

function markSourcePartial(result) {
  result.sourcePartial = true;
  result.truncated = true;
}

function appendMessage(result, role, text, timestamp, { estimatedTime = false } = {}) {
  if (role !== 'user' && role !== 'assistant') return false;
  const value = messageText(text);
  if (!value) return false;
  for (const match of value.matchAll(/<skill>\s*<name>([^<]+)<\/name>/gi)) addSkill(result, match[1]);
  if (value.startsWith('<skill>')) return false;
  const { limits } = result;
  if (limits) {
    const bounded = value.slice(0, limits.messageLength).replace(/[\uD800-\uDBFF]$/, '');
    const time = dateMillis(timestamp);
    const stats = result.readStats;
    if (role === 'user') stats.userMessages++;
    else stats.assistantMessages++;
    if (time > 0 && !estimatedTime) {
      stats.timedMessages++;
      stats.firstAt = Math.min(stats.firstAt ?? time, time);
      stats.lastAt = Math.max(stats.lastAt ?? time, time);
    }
    const entry = { role, text: bounded, agent: result.agent, time };
    if (result.trace) {
      const ref = ++result.messageSeq;
      if (role === 'user') {
        result.turn++;
        result.turnRef = ref;
      }
      entry.turnRef = result.turnRef;
    }
    result.messages.push(entry);
    result.characters += bounded.length;
    if (value.length > bounded.length) result.truncated = true;
    while (result.messages.length > limits.messages || result.characters > limits.characters) {
      const first = result.messages.shift();
      if (first.role === 'user') result.removedQuestion = first;
      result.characters -= first.text.length;
      result.truncated = true;
    }
  } else {
    const entry = { role, text: value.slice(0, maxMessageLength), agent: result.agent };
    result.messages.push(entry);
    if (result.messages.length > maxMessages) result.messages.shift();
  }
  return true;
}

function addSkill(result, name) {
  if (typeof name === 'string' && /^[\p{L}\p{N}_:.\/-]{1,140}$/u.test(name.trim())) result.usedSkills.add(name.trim());
}

function traceValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return ''; }
}

function cleanTraceText(value) {
  return traceValue(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim();
}

function addTrace(result, item) {
  if (!result.trace) return undefined;
  const text = cleanTraceText(item.text);
  const bounded = text.slice(0, traceTextLimit).replace(/[\uD800-\uDBFF]$/, '');
  const entry = {
    id: `${item.kind}-${item.callId ?? item.id ?? result.traceOrder}`,
    order: result.traceOrder++,
    kind: item.kind,
    ...(item.name ? { name: item.name } : {}),
    ...(item.callId ? { callId: item.callId } : {}),
    text: bounded,
    status: item.status,
    ...(text.length > bounded.length ? { truncated: true } : {}),
    ...(item.time ? { time: item.time } : {}),
    turnRef: result.turnRef,
    turn: result.turn,
  };
  const key = entry.kind === 'summary'
    ? `summary\0${entry.id}`
    : `${entry.kind}\0${entry.callId ?? entry.id}`;
  if (result.traceKeys.has(key)) return entry;
  result.traceKeys.add(key);
  result.trace.push(entry);
  while (result.trace.length > traceItemLimit) {
    result.truncated = true;
    const removed = result.trace.shift();
    result.traceKeys.delete(removed.kind === 'summary'
      ? `summary\0${removed.id}` : `${removed.kind}\0${removed.callId ?? removed.id}`);
  }
  return entry;
}

function traceCallId(value) {
  if (typeof value !== 'string' || !value) return undefined;
  if (value.length <= 200) return value;
  return `${value.slice(0, 120)}…${createHash('sha256').update(value).digest('hex')}`;
}

function addSummary(result, text, time, id) {
  const value = cleanTraceText(text);
  if (!value) return;
  addTrace(result, { kind: 'summary', text: value, status: 'ok', time: dateMillis(time), id });
}

function addToolCall(result, name, callId, input, time) {
  if (typeof name !== 'string' || !name.trim()) return;
  addTrace(result, {
    kind: 'tool_call', name: name.trim().slice(0, 120),
    callId: traceCallId(callId),
    text: cleanTraceText(input), status: 'pending', time: dateMillis(time),
  });
}

function addToolResult(result, callId, output, failed) {
  if (!result.trace || typeof callId !== 'string' || !callId) return;
  addTrace(result, {
    kind: 'tool_result', callId: traceCallId(callId), text: cleanTraceText(output),
    status: failed === true ? 'error' : 'ok',
  });
}

function skillPaths(result, value) {
  if (typeof value !== 'string') return;
  for (const match of value.replace(/[\\/]+/g, '/').matchAll(/(?:^|\/)([\p{L}\p{N}_:.-]+)\/SKILL\.md\b/giu)) addSkill(result, match[1]);
}

function readTool(result, name, input) {
  const data = typeof input === 'string' ? json(input) : input;
  if (typeof name !== 'string') return;
  if (name === 'exec' && typeof input === 'string' && /(?:\bGet-Content\b|\breadFile\b|\bcat\s+)/i.test(input)) skillPaths(result, input);
  if (!data) return;
  if (/^(?:skill|activate_skill)$/i.test(name)) addSkill(result, data.skill ?? data.name ?? data.skill_name);
  if (/^(?:read|exec_command|bash|shell)$/i.test(name)) {
    for (const value of [data.file_path, data.filePath, data.path, data.cmd, data.command]) skillPaths(result, value);
  }
}

function textBlocks(content, result) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = [];
  for (const block of content) {
    if (typeof block === 'string') texts.push(block);
    if (['text', 'input_text', 'output_text'].includes(block?.type) && typeof block.text === 'string') texts.push(block.text);
    if (result && block?.type === 'tool_use') {
      readTool(result, block.name, block.input);
      addToolCall(result, block.name, block.id, block.input);
    }
    if (result && block?.type === 'tool_result') {
      const value = Array.isArray(block.content)
        ? block.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
        : block.content;
      addToolResult(result, block.tool_use_id, value, block.is_error === true);
    }
    if (result && block?.type === 'tool') {
      const input = block.state?.input ?? block.input ?? block.args;
      readTool(result, block.tool ?? block.name, input);
      const callId = block.callID ?? block.callId ?? block.id;
      addToolCall(result, block.tool ?? block.name, callId, input);
      const state = block.state ?? {};
      if (state.status === 'completed' || state.status === 'error') {
        addToolResult(result, callId, state.output ?? state.result ?? state.error, state.status === 'error');
      }
    }
  }
  // A Codex user message can contain several independent input_text blocks.
  // Filter each one so an internal block never hides a neighboring prompt.
  return texts.map(stripRuntimeWrapper).filter(value => value.trim()).join('\n');
}

function firstQuestion(rows, agent) {
  for (const row of rows) {
    if (row.isSidechain || row.isMeta || row.isCompactSummary) continue;
    let body;
    if (agent === 'codex') {
      if (row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user') {
        body = textBlocks(row.payload.content);
      }
    } else if (agent === 'workbuddy') {
      if (row.type === 'message' && ['user', 'human'].includes(row.role)) body = textBlocks(row.content);
    } else if (row.type === 'user') {
      body = agent === 'qwen' && Array.isArray(row.message?.parts)
        ? row.message.parts.filter(part => !part?.thought).map(part => part?.text ?? '').join('\n')
        : textBlocks(row.message?.content);
    }
    const title = messageText(body);
    if (title && !title.startsWith('<skill>')) return title;
  }
}

async function readGeminiHistory(descriptor, cwd, config, result) {
  for (const root of configuredRoots(config, 'gemini')) {
    const [base] = await transcriptDirectories(root, ['tmp']);
    if (!base) continue;
    const file = await scopedFile(descriptor.file, base);
    if (!file || path.basename(path.dirname(file)) !== 'chats' || !/^session-.+\.jsonl?$/i.test(path.basename(file))) continue;
    const marker = await scopedFile(path.resolve(path.dirname(file), '..', '.project_root'), base);
    if (!marker || !await sameDirectory((await prefix(marker, 32 * 1024)).text.trim(), cwd)) continue;
    const { text, truncated } = await prefix(file, maxTranscriptBytes);
    if (truncated) markSourcePartial(result);
    const messages = json(text)?.messages ?? rowsFrom(text, truncated);
    if (!Array.isArray(messages)) continue;
    for (const row of messages) {
      const message = row.message ?? row;
      if (!['user', 'gemini', 'assistant'].includes(message.type)) continue;
      const content = Array.isArray(message.content) ? message.content.map(block => block?.text ?? '').join('\n') : message.content;
      appendMessage(result, message.type === 'gemini' ? 'assistant' : message.type, content, message.timestamp);
      for (const tool of Array.isArray(message.toolCalls) ? message.toolCalls : []) readTool(result, tool.name, tool.args);
    }
    return;
  }
}

async function readAntigravityHistory(descriptor, cwd, config, result) {
  for (const root of configuredRoots(config, 'antigravity')) {
    const file = await scopedFile(path.join(root, 'history.jsonl'), root);
    if (!file || pathKey(descriptor.file) !== pathKey(file)) continue;
    const { text, truncated } = await prefix(file, maxTranscriptBytes);
    for (const row of rowsFrom(text, truncated)) {
      if (row.conversationId === descriptor.id && await sameDirectory(localDirectory(row.workspace), cwd)) {
        appendMessage(result, 'user', row.display);
      }
    }
    return;
  }
}

function copilotRequests(text, truncated) {
  const snapshot = json(text);
  if (Array.isArray(snapshot?.requests)) return snapshot.requests;
  let state;
  for (const op of rowsFrom(text, truncated)) {
    if (op.kind === 0) {
      state = op.v;
      continue;
    }
    if (!Array.isArray(op.k) || op.k[0] !== 'requests' || op.k.length > 8) continue;
    const keys = op.k.map(String);
    if (keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) continue;
    const key = keys.pop();
    let target = state;
    for (const part of keys) target = target && Object.hasOwn(target, part) ? target[part] : undefined;
    if (!target || typeof target !== 'object') continue;
    if (Array.isArray(target) && (!/^\d+$/.test(key) || Number(key) >= target.length)) continue;
    if (op.kind === 1) target[key] = op.v;
    if (op.kind === 2 && Array.isArray(target[key]) && Array.isArray(op.v)) {
      const current = target[key];
      const index = Number.isInteger(op.i) ? Math.max(0, Math.min(op.i, current.length)) : current.length;
      target[key] = current.slice(0, index).concat(op.v, current.slice(index + op.v.length));
    }
    if (op.kind === 3 && !Array.isArray(target)) delete target[key];
  }
  return Array.isArray(state?.requests) ? state.requests : [];
}

async function readCopilotHistory(descriptor, cwd, config, result) {
  const stores = await Promise.all(configuredRoots(config, 'copilot').map(editorStores));
  for (const base of stores.flat()) {
    const file = await scopedFile(descriptor.file, base);
    if (!file || path.basename(path.dirname(file)) !== 'chatSessions' || !/\.jsonl?$/i.test(file)) continue;
    const workspace = await scopedFile(path.resolve(path.dirname(file), '..', 'workspace.json'), base);
    if (!workspace) continue;
    const marker = json((await prefix(workspace, 32 * 1024)).text);
    if (!await sameDirectory(localDirectory(marker?.folder), cwd)) continue;
    const { text, truncated } = await prefix(file, maxTranscriptBytes);
    if (truncated) markSourcePartial(result);
    const requests = copilotRequests(text, truncated);
    for (const request of result.limits ? requests : requests.slice(-maxMessages)) {
      appendMessage(result, 'user', request?.message?.text, request?.timestamp);
      const response = Array.isArray(request?.response) ? request.response : [];
      const answer = response.filter(item => !item?.kind || item.kind === 'markdownContent')
        .map(item => item?.value?.value ?? item?.value ?? '').filter(value => typeof value === 'string').join('');
      // Copilot stores the request time. Use it for transcript order only.
      appendMessage(result, 'assistant', answer, request?.timestamp, { estimatedTime: true });
      for (const item of response) {
        if (item?.kind === 'toolInvocationSerialized') readTool(result, item.toolId, item.parameters);
      }
    }
    return;
  }
}

async function* zstdChunks(file) {
  const decoder = zlib.createZstdDecompress();
  const input = createReadStream(file);
  input.on('error', error => decoder.destroy(error));
  try {
    yield* input.pipe(decoder);
  } finally {
    // Discovery stops after the header. Close both ends without reading the rest.
    input.destroy();
    decoder.destroy();
  }
}

async function compressedPrefix(file) {
  const { mtimeMs: modified } = await stat(file);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of zstdChunks(file)) {
    const part = chunk.subarray(0, transcriptHeaderBytes - bytes);
    if (part.length) chunks.push(part);
    bytes += part.length;
    if (part.length < chunk.length) {
      return { text: Buffer.concat(chunks, bytes).toString('utf8'), truncated: true, modified };
    }
  }
  return { text: Buffer.concat(chunks, bytes).toString('utf8'), truncated: false, modified };
}

async function* compressedRows(file) {
  // Keep at most one bounded JSONL record. Large tool outputs commonly sit
  // between the last question and answer and must not compete with them.
  let parts = [];
  let bytes = 0;
  for await (const chunk of zstdChunks(file)) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const length = end - offset;
      if (bytes <= maxTranscriptRowBytes && length) {
        bytes += length;
        if (bytes <= maxTranscriptRowBytes) parts.push(chunk.subarray(offset, end));
        else parts = [];
      }
      if (newline === -1) break;
      if (bytes > maxTranscriptRowBytes) yield null;
      else if (bytes) {
        const row = json(Buffer.concat(parts, bytes).toString('utf8').replace(/^\uFEFF/, ''));
        if (row) yield row;
      }
      offset = newline + 1;
      bytes = 0;
      parts = [];
    }
  }
  if (bytes > maxTranscriptRowBytes) yield null;
  else if (bytes) {
    const row = json(Buffer.concat(parts, bytes).toString('utf8').replace(/^\uFEFF/, ''));
    if (row) yield row;
  }
}

function readCodexRow(result, row) {
  if (row === null || row.type === 'compacted' || row.isCompactSummary) {
    if (result.limits) markSourcePartial(result);
    return;
  }
  if (row.isSidechain || row.isMeta) return;
  const payload = row.payload;
  if (row.type === 'event_msg' && payload?.type === 'token_count' && result.readStats) {
    // Codex repeats cumulative snapshots. The latest recorded total already
    // includes earlier turns, and may be available even when only a tail was read.
    const usage = payload.info?.total_token_usage;
    if (Number.isSafeInteger(usage?.total_tokens) && usage.total_tokens >= 0) {
      const tokens = { total: usage.total_tokens };
      for (const name of ['input', 'output']) {
        const value = usage[`${name}_tokens`];
        if (Number.isSafeInteger(value) && value >= 0 && value <= tokens.total) tokens[name] = value;
      }
      result.readStats.tokens = tokens;
    }
    return;
  }
  if (row.type !== 'response_item') return;
  if (payload?.type === 'message') {
    appendMessage(result, payload.role, textBlocks(payload.content, result), row.timestamp);
    return;
  }
  if (payload?.type === 'reasoning') {
    // Only the visible summary is retained; encrypted reasoning has no text.
    const summary = Array.isArray(payload.summary) ? payload.summary : [];
    const text = summary.filter(item => item?.type === 'summary_text' && typeof item.text === 'string')
      .map(item => item.text).join('\n\n');
    if (text) addSummary(result, text, row.timestamp, payload.id);
    return;
  }
  if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') {
    readTool(result, payload.name, payload.arguments ?? payload.input);
    addToolCall(result, payload.name, payload.call_id ?? payload.id, payload.arguments ?? payload.input, row.timestamp);
    return;
  }
  if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
    const output = payload.output ?? payload.content;
    const text = Array.isArray(output)
      ? output.filter(item => item?.type === 'input_text' && typeof item.text === 'string').map(item => item.text).join('\n')
      : output;
    const value = typeof text === 'string' ? text : '';
    addToolResult(result, payload.call_id, value, payload.status === 'failed'
      || /^(?:exit code: [1-9]|process exited with code [1-9])/im.test(value));
  }
}

async function readCompressedCodex(file, cwd, result) {
  // Use a separate accumulator so a damaged file never contributes an
  // incomplete history or discards previously read project context.
  const local = { messages: [], usedSkills: new Set(), limits: result.limits,
    characters: 0, truncated: false, agent: result.agent,
    trace: result.trace ? [] : undefined, traceKeys: result.trace ? new Set() : undefined,
    traceOrder: 0, messageSeq: 0, turn: 0, turnRef: undefined,
    readStats: result.readStats && { userMessages: 0, assistantMessages: 0, timedMessages: 0 } };
  let validated = false;
  for await (const row of compressedRows(file)) {
    if (!validated) {
      if (row?.type !== 'session_meta') return;
      if (!await sameDirectory(row.payload?.cwd, cwd)) return;
      validated = true;
      continue;
    }
    readCodexRow(local, row);
  }
  if (result.limits) {
    const trace = result.trace ? [...result.trace, ...local.trace] : undefined;
    Object.assign(result, local);
    if (result.trace) result.trace = trace;
  } else {
    result.messages.push(...local.messages);
    if (result.messages.length > maxMessages) result.messages.splice(0, result.messages.length - maxMessages);
    for (const skill of local.usedSkills) result.usedSkills.add(skill);
  }
}

async function transcriptTail(file) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, tailBufferBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - buffer.length);
    return parseTail(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function parseTail(buffer) {
  const truncated = buffer.length > maxTranscriptBytes;
  // Inspect one byte before the window so a complete first line isn't dropped.
  const newline = truncated ? buffer.indexOf(10, buffer.length - tailBufferBytes) : -1;
  return {
    history: truncated && newline === -1 ? [] : rowsFrom(buffer.toString('utf8', newline + 1), false),
    truncated,
  };
}

async function readJsonlHistory(descriptor, cwd, config, result) {
  const codex = descriptor.kind === 'codex';
  const locations = codex ? codexLocations : ['projects'];
  const bases = (await Promise.all(configuredRoots(config, descriptor.kind)
    .map(root => transcriptDirectories(root, locations)))).flat();
  let file;
  if (codex) file = await resolveCodexTranscript(descriptor.file, bases);
  else {
    for (const base of bases) {
      file = await scopedFile(descriptor.file, base);
      if (file) break;
    }
  }
  if (!file) return;
  if (codex && compressedCodexFile.test(file)) return readCompressedCodex(file, cwd, result);
  if (!jsonlFile.test(file)) return;
  // Validate the embedded working directory before returning messages from this source.
  const { text, truncated } = await prefix(file, transcriptHeaderBytes);
  if (!await sameDirectory(await nativeCwd(file, descriptor.kind, rowsFrom(text, truncated)), cwd)) return;
  const transcript = await transcriptTail(file);

  // Active transcripts may have a torn last row. Large transcripts keep the latest bounded tail.
  const { history } = transcript;
  if (transcript.truncated) markSourcePartial(result);
  for (const row of history) {
    if (result.limits && row.isCompactSummary) markSourcePartial(result);
    if (row.isSidechain || row.isMeta || row.isCompactSummary) continue;
    if (descriptor.kind === 'codex') {
      readCodexRow(result, row);
    } else if (descriptor.kind === 'workbuddy') {
      if (row.type === 'message') appendMessage(result, row.role === 'human' ? 'user' : row.role, textBlocks(row.content, result), row.timestamp);
      if (row.type === 'function_call') readTool(result, row.name, row.arguments);
    } else if (descriptor.kind === 'qwen' && (row.type === 'user' || row.type === 'assistant')) {
      const parts = Array.isArray(row.message?.parts) ? row.message.parts : [];
      appendMessage(result, row.type, parts.filter(part => !part?.thought && typeof part?.text === 'string').map(part => part.text).join('\n'), row.timestamp);
      for (const part of parts) readTool(result, part?.functionCall?.name, part?.functionCall?.args);
    } else if (row.type === 'user' || row.type === 'assistant') {
      appendMessage(result, row.type, textBlocks(row.message?.content, result), row.timestamp);
    }
  }
}

async function allowedArchive(descriptor, config) {
  const candidates = descriptor.kind === 'agentsview' ? config.archiveFiles ?? []
    : (await Promise.all(configuredRoots(config, 'opencode').map(opencodeDatabase))).filter(Boolean);
  const actual = await physicalPath(descriptor.file);
  if (!actual) return undefined;
  for (const candidate of candidates) {
    const allowed = await physicalPath(candidate);
    if (allowed && pathKey(allowed) === pathKey(actual)) return actual;
  }
  return undefined;
}

async function readDatabaseHistory(descriptor, cwd, config, result) {
  const file = await allowedArchive(descriptor, config);
  if (!file) return;
  const snapshot = await withDatabase(file, db => {
    if (descriptor.kind === 'agentsview') {
      const sessionFields = columns(db, 'sessions');
      const deleted = sessionFields.has('deleted_at') ? ' AND deleted_at IS NULL' : '';
      const machine = sessionFields.has('machine') ? " AND machine IN ('', 'local')" : '';
      const project = db.prepare('SELECT cwd, agent FROM sessions WHERE id = ?' + deleted + machine).get(descriptor.id);
      const fields = columns(db, 'messages');
      const content = fields.has('dialogue_text') ? "COALESCE(dialogue_text, '')" : 'content';
      const system = fields.has('is_system') ? ' AND is_system = 0' : '';
      const time = fields.has('timestamp') ? 'timestamp' : 'NULL';
      const messages = db.prepare(`SELECT role, substr(${content}, 1, ?) AS text, ${time} AS time FROM messages WHERE session_id = ? AND role IN ('user', 'assistant')${system} ORDER BY ordinal DESC LIMIT ?`)
        .all(result.limits ? result.limits.messageLength + 1 : maxMessageLength, descriptor.id,
          result.limits ? result.limits.messages + 1 : maxMessages).reverse();
      const skills = columns(db, 'tool_calls').has('skill_name') ? db.prepare('SELECT DISTINCT skill_name FROM tool_calls WHERE session_id = ? AND skill_name IS NOT NULL LIMIT 200').all(descriptor.id) : [];
      return { cwd: project?.cwd, agent: project?.agent, messages, skills };
    }
    if (!opencodeTables(db).includes(descriptor.table)) return undefined;
    const project = db.prepare(`SELECT directory FROM ${descriptor.table} WHERE id = ?`).get(descriptor.id);
    const fields = columns(db, 'session_message');
    if (['type', 'session_id', 'data'].every(field => fields.has(field))) {
      const order = fields.has('seq') ? 'seq' : 'time_created';
      const time = fields.has('time_created') ? 'time_created' : 'NULL';
      const messages = db.prepare(`SELECT type, data, ${time} AS time FROM session_message WHERE session_id = ? AND type IN ('user','assistant','skill') ORDER BY ${order} DESC LIMIT ?`)
        .all(descriptor.id, result.limits ? result.limits.messages + 1 : 100).reverse();
      if (messages.length) return { cwd: project?.directory, projection: messages };
    }
    if (!columns(db, 'message').has('data') || !columns(db, 'part').has('data')) return { cwd: project?.directory };
    const messages = db.prepare('SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT ?')
      .all(descriptor.id, result.limits ? result.limits.messages + 1 : maxMessages).reverse();
    const parts = db.prepare('SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created LIMIT 100');
    return { cwd: project?.directory, legacy: messages.map(row => ({ role: json(row.data)?.role, time: row.time_created, parts: parts.all(descriptor.id, row.id).map(part => json(part.data)) })) };
  });
  if (!snapshot || !await sameDirectory(snapshot.cwd, cwd)) return;
  if (snapshot.agent) result.agent = snapshot.agent;
  for (const row of snapshot.messages ?? []) appendMessage(result, row.role, row.text, row.time);
  for (const row of snapshot.skills ?? []) addSkill(result, row.skill_name);
  for (const row of snapshot.projection ?? []) {
    const data = json(row.data);
    if (row.type === 'skill') addSkill(result, data?.name ?? data?.skill);
    else appendMessage(result, row.type, data?.text ?? textBlocks(data?.content, result), row.time);
  }
  for (const row of snapshot.legacy ?? []) appendMessage(result, row.role, textBlocks(row.parts, result), row.time);
  if (result.limits && (snapshot.messages ?? snapshot.projection ?? snapshot.legacy ?? []).length > result.limits.messages) {
    markSourcePartial(result);
  }
}

async function readHistory(archive, cwd, config, result) {
  result.agent = archive.agent ?? archive.kind;
  if (archive.kind === 'agentsview' || archive.kind === 'opencode') await readDatabaseHistory(archive, cwd, config, result);
  if (['codex', 'claude', 'qoder', 'qwen', 'workbuddy'].includes(archive.kind)) await readJsonlHistory(archive, cwd, config, result);
  if (archive.kind === 'gemini') await readGeminiHistory(archive, cwd, config, result);
  if (archive.kind === 'antigravity') await readAntigravityHistory(archive, cwd, config, result);
  if (archive.kind === 'copilot') await readCopilotHistory(archive, cwd, config, result);
}

export async function readConversationHistory(archive, cwd, config) {
  const result = {
    messages: [], usedSkills: new Set(), limits: conversationLimits, characters: 0, truncated: false,
    trace: [], traceKeys: new Set(), traceOrder: 0, messageSeq: 0, turn: 0, turnRef: undefined,
    readStats: { userMessages: 0, assistantMessages: 0, timedMessages: 0 },
  };
  await readHistory(archive, cwd, config, result);
  const calls = new Map();
  for (const item of result.trace) {
    if (item.kind !== 'tool_call') continue;
    item.status = 'missing';
    if (item.callId) calls.set(item.callId, item);
  }
  for (const item of result.trace) {
    if (item.kind !== 'tool_result') continue;
    const call = calls.get(item.callId);
    item.turnRef = call?.turnRef;
    if (!call) {
      result.truncated = true;
      continue;
    }
    call.status = item.status;
    item.name = call.name;
    item.turn = call.turn;
  }
  if (result.messages[0]?.role === 'assistant' && result.removedQuestion) {
    // The latest retained replies may belong to a long turn whose question
    // fell out of the sliding budget. Keep that real question with its replies.
    const question = result.removedQuestion;
    while (result.messages.length >= result.limits.messages || result.characters + question.text.length > result.limits.characters) {
      result.characters -= result.messages.shift().text.length;
    }
    result.messages.unshift(question);
  }
  const start = result.messages.findIndex(message => message.role === 'user');
  const retained = start < 0 ? [] : result.messages.slice(start);
  // The last displayed reply in each source turn is its disclosure anchor.
  // A turn without a reply is anchored to its own user message.
  const indexOf = new Map(retained.map((message, index) => [message.turnRef, index]));
  const trace = result.trace
    .filter(item => item.turnRef !== undefined && indexOf.has(item.turnRef))
    .map(({ turnRef, ...item }) => ({ ...item, messageIndex: indexOf.get(turnRef) }))
    .sort((a, b) => a.turn - b.turn || a.order - b.order);
  const byMessage = new Map()
  for (const item of trace) {
    if (!Number.isInteger(item.messageIndex)) continue;
    byMessage.set(item.messageIndex, [...(byMessage.get(item.messageIndex) ?? []), item.id]);
  }
  const { userMessages, assistantMessages, timedMessages, firstAt, lastAt, tokens } = result.readStats;
  const sourceStats = {
    userMessages, assistantMessages, importedMessages: retained.length, partial: result.sourcePartial === true,
    ...(timedMessages >= 2 && timedMessages === userMessages + assistantMessages ? { elapsedMs: lastAt - firstAt } : {}),
    ...(tokens ? { tokens } : {}),
  };
  return {
    messages: retained.map(({ turnRef, ...message }, index) => ({ ...message, ...(byMessage.has(index) ? { traceIds: byMessage.get(index) } : {}) })),
    trace,
    sourceStats,
    usedSkills: [...result.usedSkills].sort(),
    truncated: result.truncated || start > 0,
  };
}

export async function readProjectHistory(project, config) {
  const result = { messages: [], usedSkills: new Set() };
  const archives = project.archives ?? (project.archive ? [project.archive] : []);
  const ordered = [...archives].filter(item => typeof item?.file === 'string').sort((a, b) => compareDate(b.date, a.date));
  for (const archive of ordered.slice(0, 12).reverse()) {
    try { await readHistory(archive, project.cwd, config, result); }
    catch { continue; }
  }
  const seen = new Set();
  const messages = result.messages.filter(({ role, text, agent }) => {
    const key = `${agent}\0${role}\0${text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { messages, usedSkills: [...result.usedSkills].sort() };
}
