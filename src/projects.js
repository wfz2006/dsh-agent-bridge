import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const maxSessions = 8_000;
const maxMessages = 36;
const maxMessageLength = 4_000;
const maxTranscriptBytes = 12 * 1024 * 1024;
const maxDecodedTranscriptBytes = 32 * 1024 * 1024;

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
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (truncated) lines.pop();
  return lines.map(json).filter(Boolean);
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
    return db.prepare(`SELECT id, cwd, agent, ${sort} AS date FROM sessions WHERE cwd <> ''${deleted}${machine} ORDER BY ${sort} DESC LIMIT ?`)
      .all(maxSessions).map(({ id, cwd, agent, date }) => ({ cwd, agent, archive: { kind: 'agentsview', agent, file, id, date } }));
  });
}

async function codexProjects(root) {
  const entries = await directories(root);
  const states = entries.filter(entry => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name));
  states.sort((a, b) => Number(b.name.match(/\d+/)[0]) - Number(a.name.match(/\d+/)[0]));
  for (const entry of states) {
    const file = await scopedFile(path.join(root, entry.name), root);
    if (!file) continue;
    const rows = await withDatabase(file, db => {
      const fields = columns(db, 'threads');
      if (!['cwd', 'rollout_path', 'id'].every(field => fields.has(field))) return undefined;
      const sort = fields.has('updated_at') ? 'updated_at' : 'id';
      return db.prepare(`SELECT id, cwd, rollout_path, ${sort} AS date FROM threads WHERE cwd <> '' ORDER BY ${sort} DESC LIMIT ?`).all(maxSessions);
    });
    if (rows) return rows.map(({ id, cwd, rollout_path: file, date }) => ({ cwd, agent: 'codex', archive: { kind: 'codex', file, root, id, date } }));
  }
  return jsonlProjects(root, 'codex', ['sessions', 'archived_sessions'], 4);
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
    const projects = tables.flatMap(table => db.prepare(`SELECT id, directory AS cwd, time_updated AS date FROM ${table} WHERE directory <> '' ORDER BY time_updated DESC LIMIT ?`)
      .all(maxSessions).map(({ id, cwd, date }) => ({ cwd, agent: 'opencode', archive: { kind: 'opencode', file, id, table, date } })));
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
      if (entry.isFile() && predicate(entry.name)) files.push(file);
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
  const files = [];
  for (const target of roots) {
    files.push(...await transcriptFiles(target, depth, maxSessions - files.length, name => /\.jsonl$/i.test(name)));
  }
  const result = [];
  for (let offset = 0; offset < files.length; offset += 32) {
    const batch = await Promise.all(files.slice(offset, offset + 32).map(async file => {
      try {
        const { text, truncated, modified } = await prefix(file, 96 * 1024);
        const cwd = await nativeCwd(file, agent, rowsFrom(text, truncated));
        return cwd ? { cwd, agent, archive: { kind: agent, file, root, date: modified } } : undefined;
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

function dateMillis(value) {
  if (typeof value === 'string') return Date.parse(value) || 0;
  return value > 0 && value < 10_000_000_000 ? value * 1_000 : value ?? 0;
}

function compareDate(a, b) {
  return dateMillis(a) - dateMillis(b);
}

async function sameDirectory(cwd, expected) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  const actual = await physicalPath(cwd);
  return pathKey(actual ?? cwd) === pathKey(expected);
}

function appendMessage(result, role, text) {
  if (!['user', 'assistant'].includes(role) || typeof text !== 'string' || !text.trim()) return;
  const value = text.trim();
  if (value.startsWith('<environment_context>') || value.startsWith('<permissions instructions>')) return;
  for (const match of value.matchAll(/<skill>\s*<name>([^<]+)<\/name>/gi)) addSkill(result, match[1]);
  if (value.startsWith('<skill>')) return;
  result.messages.push({ role, text: value.slice(0, maxMessageLength), agent: result.agent });
  if (result.messages.length > maxMessages) result.messages.shift();
}

function addSkill(result, name) {
  if (typeof name === 'string' && /^[\p{L}\p{N}_:.\/-]{1,140}$/u.test(name.trim())) result.usedSkills.add(name.trim());
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
    if (block?.type === 'tool_use') readTool(result, block.name, block.input);
    if (block?.type === 'tool') readTool(result, block.tool ?? block.name, block.state?.input ?? block.input ?? block.args);
  }
  return texts.join('\n');
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
    const messages = json(text)?.messages ?? rowsFrom(text, truncated);
    if (!Array.isArray(messages)) continue;
    for (const row of messages) {
      const message = row.message ?? row;
      if (!['user', 'gemini', 'assistant'].includes(message.type)) continue;
      const content = Array.isArray(message.content) ? message.content.map(block => block?.text ?? '').join('\n') : message.content;
      appendMessage(result, message.type === 'gemini' ? 'assistant' : message.type, content);
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
    for (const request of copilotRequests(text, truncated).slice(-maxMessages)) {
      appendMessage(result, 'user', request?.message?.text);
      const response = Array.isArray(request?.response) ? request.response : [];
      appendMessage(result, 'assistant', response.filter(item => !item?.kind || item.kind === 'markdownContent')
        .map(item => item?.value?.value ?? item?.value ?? '').filter(value => typeof value === 'string').join(''));
      for (const item of response) {
        if (item?.kind === 'toolInvocationSerialized') readTool(result, item.toolId, item.parameters);
      }
    }
    return;
  }
}

async function transcriptTail(file, compressed) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (compressed && size > maxTranscriptBytes) return undefined;
    const buffer = Buffer.alloc(Math.min(size, maxTranscriptBytes));
    const start = size - buffer.length;
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (compressed) {
      const { zstdDecompressSync } = await import('node:zlib');
      if (typeof zstdDecompressSync !== 'function') return undefined;
      const decoded = zstdDecompressSync(buffer.subarray(0, bytesRead), { maxOutputLength: maxDecodedTranscriptBytes });
      const header = rowsFrom(decoded.subarray(0, 96 * 1024).toString('utf8'), decoded.length > 96 * 1024);
      return { header, history: parseTail(decoded, decoded.length > maxTranscriptBytes) };
    }
    const raw = buffer.toString('utf8', 0, bytesRead);
    return { history: rowsFrom(start ? raw.slice(raw.indexOf('\n') + 1) : raw, false) };
  } finally {
    await handle.close();
  }
}

function parseTail(decoded, bounded) {
  const raw = decoded.subarray(Math.max(0, decoded.length - maxTranscriptBytes)).toString('utf8');
  return rowsFrom(bounded ? raw.slice(raw.indexOf('\n') + 1) : raw, false);
}

async function readJsonlHistory(descriptor, cwd, config, result) {
  const roots = configuredRoots(config, descriptor.kind);
  const locations = descriptor.kind === 'codex' ? ['sessions', 'archived_sessions'] : ['projects'];
  let file;
  for (const root of roots) {
    for (const base of await transcriptDirectories(root, locations)) {
      file ??= await scopedFile(descriptor.file, base);
    }
  }
  const compressed = descriptor.kind === 'codex' && /\.jsonl\.zst$/i.test(file ?? '');
  if (!file || (!compressed && !/\.jsonl$/i.test(file))) return;
  // Validate the embedded working directory before returning messages from this source.
  const head = compressed ? undefined : await prefix(file, 96 * 1024);
  const transcript = await transcriptTail(file, compressed);
  const rows = transcript?.header ?? rowsFrom(head?.text ?? '', head?.truncated);
  if (!transcript || !await sameDirectory(await nativeCwd(file, descriptor.kind, rows), cwd)) return;

  // Active transcripts may have a torn last row. Large transcripts keep the latest bounded tail.
  const { history } = transcript;
  for (const row of history) {
    if (row.isSidechain || row.isMeta) continue;
    if (descriptor.kind === 'codex') {
      if (row.type !== 'response_item') continue;
      const payload = row.payload;
      if (payload?.type === 'message') appendMessage(result, payload.role, textBlocks(payload.content, result));
      if (payload?.type === 'function_call') readTool(result, payload.name, payload.arguments);
      if (payload?.type === 'custom_tool_call') readTool(result, payload.name, payload.input);
    } else if (descriptor.kind === 'workbuddy') {
      if (row.type === 'message') appendMessage(result, row.role === 'human' ? 'user' : row.role, textBlocks(row.content, result));
      if (row.type === 'function_call') readTool(result, row.name, row.arguments);
    } else if (descriptor.kind === 'qwen' && (row.type === 'user' || row.type === 'assistant')) {
      const parts = Array.isArray(row.message?.parts) ? row.message.parts : [];
      appendMessage(result, row.type, parts.filter(part => !part?.thought && typeof part?.text === 'string').map(part => part.text).join('\n'));
      for (const part of parts) readTool(result, part?.functionCall?.name, part?.functionCall?.args);
    } else if (row.type === 'user' || row.type === 'assistant') {
      appendMessage(result, row.type, textBlocks(row.message?.content, result));
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
      const project = db.prepare('SELECT cwd, agent FROM sessions WHERE id = ?').get(descriptor.id);
      const fields = columns(db, 'messages');
      const content = fields.has('dialogue_text') ? "COALESCE(dialogue_text, '')" : 'content';
      const system = fields.has('is_system') ? ' AND is_system = 0' : '';
      const messages = db.prepare(`SELECT role, substr(${content}, 1, ?) AS text FROM messages WHERE session_id = ? AND role IN ('user', 'assistant')${system} ORDER BY ordinal DESC LIMIT ?`)
        .all(maxMessageLength, descriptor.id, maxMessages).reverse();
      const skills = columns(db, 'tool_calls').has('skill_name') ? db.prepare('SELECT DISTINCT skill_name FROM tool_calls WHERE session_id = ? AND skill_name IS NOT NULL LIMIT 200').all(descriptor.id) : [];
      return { cwd: project?.cwd, agent: project?.agent, messages, skills };
    }
    if (!opencodeTables(db).includes(descriptor.table)) return undefined;
    const project = db.prepare(`SELECT directory FROM ${descriptor.table} WHERE id = ?`).get(descriptor.id);
    const fields = columns(db, 'session_message');
    if (['type', 'session_id', 'data'].every(field => fields.has(field))) {
      const order = fields.has('seq') ? 'seq' : 'time_created';
      const messages = db.prepare(`SELECT type, data FROM session_message WHERE session_id = ? AND type IN ('user','assistant','skill') ORDER BY ${order} DESC LIMIT ?`)
        .all(descriptor.id, 100).reverse();
      if (messages.length) return { cwd: project?.directory, projection: messages };
    }
    if (!columns(db, 'message').has('data') || !columns(db, 'part').has('data')) return { cwd: project?.directory };
    const messages = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT ?').all(descriptor.id, maxMessages).reverse();
    const parts = db.prepare('SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created LIMIT 100');
    return { cwd: project?.directory, legacy: messages.map(row => ({ role: json(row.data)?.role, parts: parts.all(descriptor.id, row.id).map(part => json(part.data)) })) };
  });
  if (!snapshot || !await sameDirectory(snapshot.cwd, cwd)) return;
  if (snapshot.agent) result.agent = snapshot.agent;
  for (const row of snapshot.messages ?? []) appendMessage(result, row.role, row.text);
  for (const row of snapshot.skills ?? []) addSkill(result, row.skill_name);
  for (const row of snapshot.projection ?? []) {
    const data = json(row.data);
    if (row.type === 'skill') addSkill(result, data?.name ?? data?.skill);
    else appendMessage(result, row.type, data?.text ?? textBlocks(data?.content, result));
  }
  for (const row of snapshot.legacy ?? []) appendMessage(result, row.role, textBlocks(row.parts, result));
}

export async function readProjectHistory(project, config) {
  const result = { messages: [], usedSkills: new Set() };
  const archives = project.archives ?? (project.archive ? [project.archive] : []);
  const ordered = [...archives].filter(item => typeof item?.file === 'string').sort((a, b) => compareDate(b.date, a.date));
  for (const archive of ordered.slice(0, 12).reverse()) {
    try {
      result.agent = archive.agent ?? archive.kind;
      if (archive.kind === 'agentsview' || archive.kind === 'opencode') await readDatabaseHistory(archive, project.cwd, config, result);
      if (['codex', 'claude', 'qoder', 'qwen', 'workbuddy'].includes(archive.kind)) await readJsonlHistory(archive, project.cwd, config, result);
      if (archive.kind === 'gemini') await readGeminiHistory(archive, project.cwd, config, result);
      if (archive.kind === 'antigravity') await readAntigravityHistory(archive, project.cwd, config, result);
      if (archive.kind === 'copilot') await readCopilotHistory(archive, project.cwd, config, result);
    } catch { continue; }
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
