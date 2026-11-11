import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { discoverRoots, loadConfig } from '../src/config.js'

test('discovers native sources from Windows user and Agent data directories', () => {
  const home = 'C:\\Users\\Example'
  const { agentRoots, workspaceHubRoots } = discoverRoots(home, {
    APPDATA: 'C:\\UserData\\Roaming',
    CODEX_HOME: 'C:\\UserData\\Codex',
    OPENCODE_DB: 'C:\\UserData\\OpenCode\\custom.sqlite',
  }, 'win32')
  assert.deepEqual(agentRoots.codex, ['C:\\UserData\\Codex', home + '\\.codex'])
  assert.ok(agentRoots.copilot.includes('C:\\UserData\\Roaming\\Code\\User'))
  assert.ok(agentRoots.opencode.includes('C:\\UserData\\OpenCode\\custom.sqlite'))
  assert.deepEqual(workspaceHubRoots, [home + '\\.agentsview\\workspacehub'])
})

test('uses XDG locations on Linux and Application Support for macOS editors', () => {
  const linux = discoverRoots('/home/example', {
    XDG_DATA_HOME: '/mnt/data',
    XDG_CONFIG_HOME: '/mnt/config',
    CLAUDE_CONFIG_DIR: '/mnt/claude',
  }, 'linux')
  assert.ok(linux.agentRoots.claude.includes('/mnt/claude'))
  assert.ok(linux.agentRoots.opencode.includes('/mnt/data/opencode'))
  assert.ok(linux.agentRoots.copilot.includes('/mnt/config/Code/User'))
  assert.ok(linux.opencodeSkillRoots.includes('/mnt/config/opencode'))
  const mac = discoverRoots('/Users/example', {}, 'darwin')
  assert.ok(mac.agentRoots.copilot.includes('/Users/example/Library/Application Support/Code/User'))
})

test('user configuration overrides discovery and resolves relative and home paths consistently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-config-'))
  try {
    const home = join(directory, 'profile')
    const file = join(directory, 'agent-bridge.json')
    await writeFile(file, JSON.stringify({
      agentRoots: { 'claude-code': [], codex: ['custom-agent'] },
      workspaceHubRoots: [],
      archiveFiles: [],
      memoryExports: { '~/projects/example': ['memory.md'] },
    }))
    const config = await loadConfig({ USERPROFILE: home, HOME: home, DSH_AGENT_BRIDGE_CONFIG: file })
    assert.equal(config.home, home)
    assert.deepEqual(config.agentRoots.claude, [])
    assert.deepEqual(config.agentRoots.codex, [join(directory, 'custom-agent')])
    assert.deepEqual(config.workspaceHubRoots, [])
    assert.deepEqual(config.archiveFiles, [])
    assert.deepEqual(config.memoryExports[join(home, 'projects', 'example')], [join(directory, 'memory.md')])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
