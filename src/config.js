import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, posix, resolve, win32 } from 'node:path'

export function discoverRoots(home, env, platform) {
  const path = platform === 'win32' ? win32 : posix
  const absolute = (...values) => [...new Set(values.filter(value => typeof value === 'string' && path.isAbsolute(value)).map(path.normalize))]
  const data = absolute(env.XDG_DATA_HOME, path.join(home, '.local', 'share'))
  const configs = absolute(env.XDG_CONFIG_HOME, path.join(home, '.config'))
  const roaming = platform === 'win32' ? absolute(env.APPDATA, path.join(home, 'AppData', 'Roaming'))
    : platform === 'darwin' ? [path.join(home, 'Library', 'Application Support')] : configs
  const manager = absolute(env.AGENTSVIEW_DATA_DIR || env.AGENT_VIEWER_DATA_DIR, path.join(home, '.agentsview'))
  return {
    agentRoots: {
      codex: absolute(env.CODEX_HOME, path.join(home, '.codex')),
      claude: absolute(env.CLAUDE_CONFIG_DIR, path.join(home, '.claude')),
      opencode: absolute(env.OPENCODE_DB, ...data.map(root => path.join(root, 'opencode'))),
      qoder: [path.join(home, '.qoder-cn'), path.join(home, '.qoder')],
      qwen: [path.join(home, '.qwen')],
      workbuddy: [path.join(home, '.workbuddy')],
      gemini: [path.join(home, '.gemini')],
      antigravity: [path.join(home, '.gemini', 'antigravity'), path.join(home, '.gemini', 'antigravity-cli')],
      trae: [...roaming.flatMap(root => ['Trae', 'Trae CN'].map(product => path.join(root, product, 'User'))),
        path.join(home, '.trae'), path.join(home, '.trae-cn')],
      copilot: [...roaming.flatMap(root => ['Code', 'Code - Insiders', 'VSCodium'].map(product => path.join(root, product, 'User'))),
        path.join(home, '.copilot')],
    },
    opencodeSkillRoots: absolute(env.OPENCODE_CONFIG_DIR, ...configs.map(root => path.join(root, 'opencode'))),
    workspaceHubRoots: manager.map(root => path.join(root, 'workspacehub')),
    archiveFiles: manager.map(root => path.join(root, 'sessions.db')),
  }
}

function resolvePath(value, base, home) {
  if (value === '~') return home
  if (/^~[\\/]/.test(value)) return join(home, value.slice(2))
  return isAbsolute(value) ? normalize(value) : resolve(base, value)
}

function paths(value, key, base, home) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${key} 应为目录或文件路径数组。`)
  }
  return [...new Set(value.map(item => resolvePath(item, base, home)))]
}

function pathMap(value, key, base, home) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error(`${key} 应为名称到路径数组的映射。`)
  return Object.fromEntries(Object.entries(value ?? {}).map(
    ([label, roots]) => [label, paths(roots, `${key}.${label}`, base, home)],
  ))
}

export async function loadConfig(env = process.env) {
  const nativeHome = process.platform === 'win32' ? env.USERPROFILE : env.HOME
  const home = typeof nativeHome === 'string' && isAbsolute(nativeHome) ? normalize(nativeHome) : homedir()
  const file = resolve(env.DSH_AGENT_BRIDGE_CONFIG || join(env.DSH_HOME || join(home, '.dsh'), 'agent-bridge.json'))
  const base = dirname(file)
  let raw = {}
  try {
    raw = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取 agent-bridge.json。请检查 JSON 和文件权限。')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('agent-bridge.json 应为 JSON 对象。')
  const detected = discoverRoots(home, env, process.platform)
  const workspaceHubRoots = paths(raw.workspaceHubRoots ?? detected.workspaceHubRoots, 'workspaceHubRoots', base, home)
  const archiveFiles = paths(raw.archiveFiles ?? [
    ...workspaceHubRoots.map(root => join(dirname(root), 'sessions.db')),
    ...detected.archiveFiles,
  ], 'archiveFiles', base, home)
  const overrides = pathMap(raw.agentRoots, 'agentRoots', base, home)
  const aliases = { 'claude-code': 'claude', 'open-code': 'opencode', 'qoder-cn': 'qoder', 'trae-cn': 'trae' }
  for (const [alias, provider] of Object.entries(aliases)) {
    if (Object.hasOwn(overrides, alias) && !Object.hasOwn(overrides, provider)) overrides[provider] = overrides[alias]
    delete overrides[alias]
  }
  const memoryExports = Object.fromEntries(Object.entries(pathMap(raw.memoryExports, 'memoryExports', base, home))
    .map(([workspace, exports]) => [resolvePath(workspace, base, home), exports]))
  return {
    home, configFile: file, workspaceHubRoots, archiveFiles, memoryExports,
    agentRoots: { ...detected.agentRoots, ...overrides },
    opencodeSkillRoots: paths(raw.opencodeSkillRoots ?? detected.opencodeSkillRoots, 'opencodeSkillRoots', base, home),
    skillRoots: paths(raw.skillRoots, 'skillRoots', base, home),
    projectRoots: paths(raw.projectRoots, 'projectRoots', base, home),
  }
}
