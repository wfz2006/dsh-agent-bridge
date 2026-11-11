import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../src/index.js'

test('the panel authenticates, refreshes changed project files, and exports reviewed handoffs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-http-'))
  const config = join(directory, 'agent-bridge.json')
  await writeFile(config, JSON.stringify({ projectRoots: [directory], workspaceHubRoots: [], archiveFiles: [] }))
  await writeFile(join(directory, 'AGENTS.md'), 'bridge-test-context')
  const memoryDirectory = join(directory, '.agent-bridge', 'memory')
  await mkdir(memoryDirectory, { recursive: true })
  const previousConfig = process.env.DSH_AGENT_BRIDGE_CONFIG
  process.env.DSH_AGENT_BRIDGE_CONFIG = config
  const routes = new Map()
  const cleanups = []
  apply({
    effect: register => {
      const cleanup = register()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    webServer: { register: route => routes.set(route.path, route.handler) },
    connection: { requestRejection: req => req.headers.cookie === 'signed-in=yes' ? undefined : 'missing-cookie' },
  })
  const server = createServer((req, res) => routes.get(req.url)(req, res))
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/agent-bridge/`
    assert.equal((await fetch(base + 'panel')).status, 403)
    const headers = { Cookie: 'signed-in=yes', 'Content-Type': 'application/json' }
    const panel = await fetch(base + 'panel', { headers })
    assert.equal(panel.status, 200)
    assert.equal(panel.headers.get('cache-control'), 'no-store')
    const page = await panel.text()
    const nonce = page.match(/name="bridge-nonce" content="([a-f0-9]+)"/)?.[1]
    assert.ok(nonce)
    assert.equal((await fetch(base + 'api', { method: 'POST', headers, body: '{"action":"catalog"}' })).status, 403)
    headers['X-DSH-Agent-Bridge'] = nonce
    const api = body => fetch(base + 'api', { method: 'POST', headers, body: JSON.stringify(body) })
    const listing = await (await api({ action: 'catalog' })).json()
    const project = listing.projects.find(entry => entry.cwd === directory)
    assert.ok(project)
    assert.equal(project.online, true)
    assert.equal((await api({ action: 'open', path: directory, prompt: 'unreviewed' })).status, 409)
    assert.equal((await api({ action: 'preview', projectId: project.id, assetIds: ['arbitrary'] })).status, 409)
    const detail = await (await api({ action: 'detail', projectId: project.id })).json()
    const memory = detail.memories.find(entry => entry.file.endsWith('AGENTS.md'))
    assert.ok(memory)
    const reviewed = await (await api({ action: 'preview', projectId: project.id, assetIds: [memory.id] })).json()
    assert.match(reviewed.prompt, /bridge-test-context/)
    const opened = await (await api({ action: 'open', ticket: reviewed.ticket })).json()
    assert.equal(opened.path, directory)
    assert.equal(opened.prompt, reviewed.prompt)
    assert.equal(reviewed.canImport, true)
    assert.equal((await api({ action: 'export', ticket: 'missing' })).status, 409)
    const exported = await (await api({ action: 'export', ticket: reviewed.ticket })).json()
    assert.match(exported.filename, /\.md$/)
    assert.ok(exported.markdown.includes(reviewed.prompt))
    const dshSession = await (await api({ action: 'export-session', conversation: {
      title: '独立 DSH 会话', path: join(directory, 'other'), truncated: true,
      messages: [
        { role: 'user', text: '接续这里。' },
        { role: 'assistant', text: '下一步已记录。 api_key = hide-me-now' },
        { role: 'tool', text: 'raw-tool-output' },
      ],
    } })).json()
    assert.match(dshSession.markdown, /下一步已记录/)
    assert.match(dshSession.markdown, /部分内容已截取/)
    assert.doesNotMatch(dshSession.markdown, /raw-tool-output|hide-me-now/)

    const before = await (await api({ action: 'changes', projectId: project.id })).json()
    const pending = api({ action: 'changes', revision: before.revision, projectId: project.id, wait: true })
    await writeFile(join(memoryDirectory, 'new-note.md'), 'discovered by filesystem refresh')
    const changed = await (await pending).json()
    assert.ok(changed.changed)
    assert.ok(changed.revision > before.revision)
    const refreshed = await (await api({ action: 'detail', projectId: project.id })).json()
    assert.ok(refreshed.memories.some(entry => entry.file.endsWith('new-note.md')))
  } finally {
    if (previousConfig === undefined) delete process.env.DSH_AGENT_BRIDGE_CONFIG
    else process.env.DSH_AGENT_BRIDGE_CONFIG = previousConfig
    for (const cleanup of cleanups.reverse()) cleanup()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
