import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { apply } from '../src/index.js'
import { approveConversation, finishConversation, stageConversation } from '../src/conversation-store.js'

test('the panel authenticates, refreshes changed project files, and exports reviewed handoffs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-http-'))
  const config = join(directory, 'agent-bridge.json')
  await writeFile(config, JSON.stringify({ projectRoots: [directory], workspaceHubRoots: [], archiveFiles: [] }))
  await writeFile(join(directory, 'AGENTS.md'), 'bridge-test-context')
  const memoryDirectory = join(directory, '.agent-bridge', 'memory')
  await mkdir(memoryDirectory, { recursive: true })
  const targetName = '设计 #1 (50%).md'
  const targetPath = join(directory, targetName)
  const reference = '../../%E8%AE%BE%E8%AE%A1%20%231%20(50%25).md'
  const notePath = join(memoryDirectory, 'links.md')
  await writeFile(targetPath, '# target')
  const scriptPath = join(directory, 'probe.js')
  const outside = join(directory, 'sibling-source')
  await mkdir(outside)
  await mkdir(join(directory, 'references'))
  await writeFile(join(directory, 'references', 'real.md'), '# real')
  await writeFile(join(outside, 'real.md'), '# unverified')
  await writeFile(scriptPath, '// should only be revealed')
  await writeFile(notePath, `# C#\n\n[打开设计](<${reference}>)\n\n[越界](../../../other.md)\n\n[脚本](../../probe.js)\n\n[资料](../../references/real.md)\n\n[缺失](../../missing.md)`)
  const traceSessionId = '7d4f5e60-4444-4555-8666-c77788889999'
  const traceDirectory = join(directory, 'agent-bridge-traces')
  await mkdir(traceDirectory, { recursive: true })
  const detachedId = '11111111-1111-1111-1111-111111111111'
  const statsOnlyId = '22222222-2222-4222-8222-222222222222'
  const sourceStats = { userMessages: 1, assistantMessages: 2, importedMessages: 3, partial: false }
  const traceFile = {
    version: 1, sessionId: traceSessionId, savedAt: '2026-11-17T00:00:00.000Z',
    trace: [
      { id: 't0', kind: 'tool_call', name: 'shell', text: 'bridge-trace-arguments', status: 'ok' },
      { id: 't1', kind: 'tool_result', name: 'shell', text: 'bridge-trace-result', status: 'ok' },
    ],
  }
  await writeFile(join(traceDirectory, `${traceSessionId}.json`), JSON.stringify(traceFile))
  await writeFile(join(traceDirectory, `${detachedId}.json`), JSON.stringify({ ...traceFile, sessionId: detachedId }))
  await writeFile(join(traceDirectory, `${statsOnlyId}.json`), JSON.stringify({
    ...traceFile, sessionId: statsOnlyId, trace: [], sourceStats,
  }))
  const archiveId = '6d4f5e60-4444-4555-8666-c77788889999'
  const previewId = '1a4f5e60-4444-4555-8666-c77788889999'
  const previewSessionId = '1b4f5e60-4444-4555-8666-c77788889999'
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex')
  const document = Buffer.from('<html><p>attachment</p></html>')
  const imageName = '中文 #1 (50%).png'
  const documentName = '说明 #2 (50%).html'
  const duplicateName = "第二份's.html"
  async function* archiveEvents() {
    yield { kind: 'message', role: 'user', turn: 7, text: 'Begin archive' }
    yield { kind: 'tool_call', callId: 'archive-call', name: 'read', turn: 7, text: 'details' }
    yield { kind: 'attachment', turn: 7, name: imageName, data: image }
    yield { kind: 'attachment', turn: 7, name: documentName, data: document }
    yield { kind: 'attachment', turn: 7, name: duplicateName, data: document }
    yield { kind: 'message', role: 'assistant', turn: 7, text: '```csharp\r\nfirst\r\n\r\nlast\r\n```' }
  }
  const settings = { configFile: config }
  await stageConversation(settings, { id: archiveId, sessionId: traceSessionId, sourceCwd: directory }, archiveEvents(), String)
  await approveConversation(settings, archiveId)
  await finishConversation(settings, archiveId)
  await stageConversation(settings, { id: previewId, sessionId: previewSessionId, sourceCwd: directory }, archiveEvents(), String)
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
    connection: {
      requestRejection: req => req.headers.cookie ? undefined : 401,
      admit: req => {
        if (req.headers.cookie === 'signed-in=yes') return { peer: { principal: { kind: 'owner' } } }
        if (req.headers.cookie === 'signed-in=guest') return { peer: { principal: { kind: 'share-link' } } }
        if (req.headers.cookie === 'signed-in=unknown') return { peer: {} }
        return { rejection: 401 }
      },
    },
    get: service => service === 'sessionPersistence' ? {
      stat: async id => [traceSessionId, statsOnlyId].includes(id) ? { header: { id } } : undefined,
    } : undefined,
  })
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!route) {
      res.writeHead(404).end()
      return
    }
    route(req, res)
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/agent-bridge/`
    assert.equal((await fetch(base + 'panel')).status, 403)
    const headers = { Cookie: 'signed-in=yes', 'Content-Type': 'application/json' }
    const panel = await fetch(base + 'panel', { headers })
    assert.equal(panel.status, 200)
    assert.equal(panel.headers.get('cache-control'), 'no-store')
    assert.match(panel.headers.get('content-security-policy'), /img-src 'self'/)
    const page = await panel.text()
    const nonce = page.match(/name="bridge-nonce" content="([a-f0-9]+)"/)?.[1]
    assert.ok(nonce)
    assert.equal((await fetch(base + 'api', { method: 'POST', headers, body: '{"action":"catalog"}' })).status, 403)
    assert.equal((await fetch(base + 'api', {
      method: 'POST', headers, body: JSON.stringify({ action: 'set-project-pin', projectId: '0'.repeat(24), pinned: true }),
    })).status, 403)
    headers['X-DSH-Agent-Bridge'] = nonce
    const api = body => fetch(base + 'api', { method: 'POST', headers, body: JSON.stringify(body) })
    const listing = await (await api({ action: 'catalog' })).json()
    assert.deepEqual(Object.keys(listing.agentIcons).sort(), [
      'antigravity', 'claude', 'codex', 'copilot', 'dsh', 'gemini',
      'opencode', 'qoder', 'qwen', 'trae', 'workbuddy',
    ])
    assert.equal((await fetch(base + listing.agentIcons.copilot)).status, 403)
    const markdownModule = await fetch(base + 'markdown.js', { headers })
    assert.equal(markdownModule.status, 200)
    assert.equal(markdownModule.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.match(await markdownModule.text(), /export function renderMarkdown/)
    const archiveUrl = base + `conversation-history?sessionId=${traceSessionId}`
    assert.equal((await fetch(archiveUrl, { headers: { Cookie: 'signed-in=guest' } })).status, 403)
    const fullHistory = await (await fetch(archiveUrl, { headers })).json()
    assert.equal(fullHistory.history.messages, 2)
    assert.equal(fullHistory.history.tools, 1)
    const processUrl = base + `conversation-process?sessionId=${traceSessionId}`
    assert.equal((await fetch(processUrl, { headers: { Cookie: 'signed-in=guest' } })).status, 403)
    const processIndex = await (await fetch(processUrl, { headers })).json()
    assert.deepEqual(processIndex.placements, [
      { nativeTurn: 1, sourceTurn: 7, start: 0, anchor: 4, tail: false, after: 1, before: 6, calls: 1, count: 1 },
    ])
    assert.deepEqual((await (await fetch(processUrl + '&turn=7&after=2&before=6', { headers })).json()).items, [])
    const processPage = await (await fetch(processUrl + '&turn=7', { headers })).json()
    assert.deepEqual(processPage.items.map(({ kind, name, status }) => [kind, name, status]), [['tool_call', 'read', 'missing']])
    assert.deepEqual((await (await fetch(processUrl + '&turn=1', { headers })).json()).items, [])
    assert.equal((await fetch(processUrl + '&turn=0', { headers })).status, 400)
    const attachment = fullHistory.items.find(item => item.name === imageName)
    const attachmentLink = values => base + `conversation-attachment?${new URLSearchParams(values)}`
    const dispositionName = response => decodeURIComponent(response.headers.get('content-disposition').split("filename*=UTF-8''")[1])
    const filename = await fetch(attachmentLink({ sessionId: traceSessionId, attachmentId: attachment.attachmentId }), { headers })
    assert.match(filename.headers.get('content-disposition'), /^attachment; filename="[a-f0-9]{12}\.png";/)
    assert.equal(dispositionName(filename), imageName)
    const imageResponse = await fetch(attachmentLink({ sessionId: traceSessionId, attachmentId: attachment.attachmentId, inline: 'true' }), { headers })
    assert.equal(imageResponse.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), image)
    assert.match(imageResponse.headers.get('content-disposition'), /^inline;/)
    assert.equal(dispositionName(imageResponse), imageName)
    const file = fullHistory.items.find(item => item.name === documentName)
    const secondFile = fullHistory.items.find(item => item.name === duplicateName)
    assert.equal(file.attachmentId, secondFile.attachmentId)
    for (const item of [file, secondFile]) {
      const response = await fetch(attachmentLink({ sessionId: traceSessionId, attachmentId: item.attachmentId, seq: item.seq, inline: 'true', filename: 'ignored.html' }), { headers })
      assert.equal(response.headers.get('content-type'), 'application/octet-stream')
      assert.match(response.headers.get('content-disposition'), /^attachment;/)
      assert.equal(dispositionName(response), item.name)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), document)
    }
    const preview = attachmentLink({ snapshotId: previewId, attachmentId: attachment.attachmentId, seq: attachment.seq, inline: 'true' })
    assert.equal((await fetch(preview, { headers: { Cookie: 'signed-in=guest' } })).status, 403)
    const previewImage = await fetch(preview, { headers })
    assert.equal(previewImage.status, 200)
    assert.deepEqual(Buffer.from(await previewImage.arrayBuffer()), image)
    assert.equal((await fetch(attachmentLink({ snapshotId: archiveId, attachmentId: attachment.attachmentId }), { headers })).status, 404)
    assert.equal((await fetch(attachmentLink({ snapshotId: previewId, sessionId: traceSessionId, attachmentId: attachment.attachmentId }), { headers })).status, 400)
    assert.equal((await fetch(attachmentLink({ snapshotId: previewId, attachmentId: attachment.attachmentId, seq: file.seq }), { headers })).status, 404)
    const db = new DatabaseSync(join(directory, 'agent-bridge-history', 'history.sqlite'))
    try {
      db.prepare('UPDATE snapshots SET created=0 WHERE id=?').run(previewId)
    } finally {
      db.close()
    }
    assert.equal((await fetch(preview, { headers })).status, 404)
    const downloadUrl = base + `conversation-export?sessionId=${traceSessionId}&format=share`
    const unreviewed = await fetch(downloadUrl, { headers })
    assert.equal(unreviewed.status, 409)
    assert.equal(unreviewed.headers.get('content-disposition'), null)
    const previewUrl = base + `conversation-share-preview?sessionId=${traceSessionId}`
    assert.equal((await fetch(previewUrl, { headers: { Cookie: 'signed-in=guest' } })).status, 403)
    const response = await fetch(previewUrl, { headers })
    assert.match(response.headers.get('content-type'), /^text\/plain/)
    assert.equal(response.headers.get('content-disposition'), null)
    const fullMarkdown = await response.text()
    assert.ok(fullMarkdown.includes('```csharp\r\nfirst\r\n\r\nlast\r\n```'))
    assert.ok(!fullMarkdown.includes('archive-call'))
    assert.ok(!fullMarkdown.includes(directory))
    assert.match(await (await fetch(previewUrl + '&includeTrace=true', { headers })).text(), /archive-call/)
    const localHistory = await fetch(downloadUrl.replace('format=share', 'format=local'), { headers })
    assert.match(localHistory.headers.get('content-disposition'), /^attachment/)
    assert.match(await localHistory.text(), /file:\/\//)
    for (const path of Object.values(listing.agentIcons)) {
      const icon = await fetch(base + path, { headers })
      assert.equal(icon.status, 200, path)
      if (path.endsWith('.svg')) {
        assert.equal(icon.headers.get('content-type'), 'image/svg+xml', path)
        assert.match(await icon.text(), /<svg/, path)
      } else {
        assert.equal(icon.headers.get('content-type'), 'image/png', path)
        const bytes = Buffer.from(await icon.arrayBuffer())
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', path)
      }
    }
    const project = listing.projects.find(entry => entry.cwd === directory)
    assert.ok(project)
    assert.equal(project.online, true)
    assert.equal(project.pinned, false)
    assert.equal(project.continuedAt, null)
    assert.equal((await api({ action: 'open', path: directory, prompt: 'unreviewed' })).status, 409)
    assert.equal((await api({ action: 'preview', projectId: project.id, assetIds: ['arbitrary'] })).status, 409)
    assert.equal((await api({ action: 'preview-skill-activation', projectId: project.id, assetIds: ['0'.repeat(24)] })).status, 409)
    assert.equal((await api({ action: 'apply-skill-activation', ticket: 'missing' })).status, 409)
    assert.equal((await api({
      action: 'deactivate-skill-activation', projectId: project.id, activationId: '0'.repeat(24),
    })).status, 409)
    const detail = await (await api({ action: 'detail', projectId: project.id })).json()
    assert.equal(detail.selection, null)
    const memory = detail.memories.find(entry => entry.file.endsWith('AGENTS.md'))
    assert.ok(memory)
    const note = detail.memories.find(entry => entry.file === notePath)
    const body = await (await api({ action: 'asset', projectId: project.id, assetId: note.id })).json()
    const link = body.references.find(item => item.href === reference)
    assert.equal(link.path, targetPath)
    assert.equal(body.references.find(item => item.href === '../../../other.md').error, '文件不在项目范围内。')
    assert.match(body.references.find(item => item.href === '../../missing.md').error, /已移动、不可访问/)
    const resolveRef = () => api({ action: 'resolve-open-path', projectId: project.id, referenceId: link.id })
    assert.equal((await (await resolveRef()).json()).path, targetPath)
    const linkDraft = await (await api({ action: 'preview', projectId: project.id, assetIds: [note.id] })).json()
    const downloadLinkDraft = async format => (await (await api({ action: 'export', ticket: linkDraft.ticket, format })).json()).markdown
    const localWithLink = await downloadLinkDraft('local')
    assert.ok(localWithLink.includes(`[打开设计](<${pathToFileURL(targetPath).href}>)`), localWithLink)
    const shareWithPath = await downloadLinkDraft('share')
    assert.ok(shareWithPath.includes(`打开设计（\`${targetName}\`）`), shareWithPath)
    assert.doesNotMatch(shareWithPath, /file:\/\/|\[越界\]\(|\[缺失\]\(/)
    const claimedSavePath = await (await api({ action: 'export', ticket: linkDraft.ticket, format: 'share',
      savePath: join(directory, 'handoff.md'),
    })).json()
    assert.equal(claimedSavePath.markdown, shareWithPath)
    const script = body.references.find(item => item.href === '../../probe.js')
    const scriptTarget = await (await api({ action: 'resolve-open-path', projectId: project.id, referenceId: script.id })).json()
    assert.equal(scriptTarget.revealOnly, true)
    const linkedAsset = body.references.find(item => item.href === '../../references/real.md')
    await rename(join(directory, 'references'), join(directory, 'retained-references'))
    await symlink(outside, join(directory, 'references'), 'junction')
    assert.equal((await api({ action: 'resolve-open-path', projectId: project.id, referenceId: linkedAsset.id })).status, 409)
    await rename(targetPath, `${targetPath}.moved`)
    await writeFile(targetPath, '# replacement')
    assert.equal((await resolveRef()).status, 409)
    const localAfterReplacement = await downloadLinkDraft('local')
    assert.ok(localAfterReplacement.includes(`打开设计（\`${targetName}\`）`), localAfterReplacement)
    assert.ok(!localAfterReplacement.includes(pathToFileURL(targetPath).href), localAfterReplacement)
    assert.equal((await api({ action: 'resolve-open-path', projectId: project.id, path: targetPath })).status, 400)
    const pin = await (await api({ action: 'set-project-pin', projectId: project.id, pinned: true })).json()
    assert.equal(pin.pinned, true)
    const selection = await (await api({ action: 'set-project-selection', projectId: project.id, assetIds: [memory.id], history: false })).json()
    assert.deepEqual(selection.selection, { assetIds: [memory.id], history: false })
    const reviewed = await (await api({ action: 'preview', projectId: project.id, assetIds: [memory.id] })).json()
    assert.match(reviewed.prompt, /bridge-test-context/)
    const openDirectory = await (await api({ action: 'resolve-open-path', projectId: project.id, directory: true })).json()
    assert.equal(openDirectory.kind, 'directory')
    assert.equal(openDirectory.path, directory)
    const openFile = await (await api({ action: 'resolve-open-path', projectId: project.id, assetId: memory.id })).json()
    assert.equal(openFile.kind, 'file')
    assert.equal(openFile.path, join(directory, 'AGENTS.md'))
    assert.equal((await api({ action: 'resolve-open-path', projectId: project.id, assetId: 'f'.repeat(24) })).status, 404)
    assert.equal((await api({ action: 'resolve-open-path', projectId: project.id, assetId: 'not-an-id' })).status, 400)
    // Even with the owner's nonce, an admitted non-owner must not read or change local data.
    const guest = { ...headers, Cookie: 'signed-in=guest' }
    const forbidden = await Promise.all([
      fetch(base + 'panel', { headers: guest }),
      fetch(base + listing.agentIcons.copilot, { headers: guest }),
      fetch(base + 'api', { method: 'POST', headers: { ...guest, Cookie: 'signed-in=unknown' }, body: '{' }),
      ...[
        { action: 'catalog' }, { action: 'detail', projectId: project.id },
        { action: 'asset', projectId: project.id, assetId: memory.id },
        { action: 'resolve-open-path', projectId: project.id, assetId: memory.id },
        { action: 'export', ticket: reviewed.ticket }, { action: 'open', ticket: reviewed.ticket },
        { action: 'set-project-archive', projectIds: [project.id], archived: true },
        { action: 'set-project-pin', projectId: project.id, pinned: false },
        { action: 'set-project-selection', projectId: project.id, assetIds: [], history: true },
        { action: 'preview-skill-activation', projectId: project.id, assetIds: ['0'.repeat(24)] },
        { action: 'apply-skill-activation', ticket: 'missing' },
        { action: 'deactivate-skill-activation', projectId: project.id, activationId: '0'.repeat(24) },
        { action: 'undo-skill-activation', projectId: project.id, activationId: '0'.repeat(24) },
      ].map(body => fetch(base + 'api', { method: 'POST', headers: guest, body: JSON.stringify(body) })),
    ])
    assert.deepEqual(forbidden.map(response => response.status), Array(forbidden.length).fill(403))
    const stillOwnerState = await (await api({ action: 'detail', projectId: project.id })).json()
    assert.equal(stillOwnerState.project.pinned, true)
    assert.equal(stillOwnerState.project.archived, false)
    assert.deepEqual(stillOwnerState.selection, { assetIds: [memory.id], history: false })
    assert.equal((await api({ action: 'record-project-continuation', ticket: reviewed.ticket })).status, 409)
    const opened = await (await api({ action: 'open', ticket: reviewed.ticket })).json()
    assert.equal(opened.path, directory)
    assert.equal(opened.prompt, reviewed.prompt)
    const continuation = await (await api({ action: 'record-project-continuation', ticket: reviewed.ticket })).json()
    assert.equal(continuation.projectId, project.id)
    assert.ok(Number.isSafeInteger(continuation.continuedAt))
    assert.equal(reviewed.canImport, true)
    assert.equal((await api({ action: 'export', ticket: 'missing' })).status, 409)
    const exported = await (await api({ action: 'export', ticket: reviewed.ticket })).json()
    assert.match(exported.filename, /\.md$/)
    // The export is a human-readable document built from the reviewed preview,
    // not a verbatim copy of the model draft.
    assert.match(exported.markdown, /^# .+ · 开发交接$/m)
    assert.match(exported.markdown, /^## 资料索引$/m)
    assert.match(exported.markdown, /bridge-test-context/)
    assert.match(exported.markdown, /file:\/\/\//)
    assert.match(exported.markdown, /^\*\*工作目录\*\*：\[[^\]]+\]\(<file:\/\/\//m)
    const conversation = {
      title: '独立 DSH 会话', path: join(directory, 'other'), truncated: true,
      messages: [
        { role: 'user', text: '接续这里。' },
        { role: 'assistant', text: '下一步已记录。 api_key = hide-me-now' },
        { role: 'tool', text: 'raw-tool-output' },
      ],
    }
    const dshSession = await (await api({ action: 'export-session', conversation, sessionId: traceSessionId })).json()
    assert.match(dshSession.markdown, /下一步已记录/)
    assert.match(dshSession.markdown, /部分内容已截取/)
    assert.doesNotMatch(dshSession.markdown, /raw-tool-output|hide-me-now|来源记录/)
    assert.equal((await fetch(`${base}session-trace?sessionId=not-a-session`, { headers })).status, 400)
    assert.equal((await fetch(`${base}session-trace?sessionId=${detachedId}`, { headers })).status, 404)
    const traceResponse = await fetch(`${base}session-trace?sessionId=${traceSessionId}`, { headers })
    assert.equal(traceResponse.status, 200)
    const savedTrace = await traceResponse.json()
    assert.equal(savedTrace.sessionId, traceSessionId)
    assert.deepEqual(savedTrace.trace.map(item => item.text), ['bridge-trace-arguments', 'bridge-trace-result'])
    assert.equal(savedTrace.traceCounts.toolCall, 1)
    assert.equal(savedTrace.sourceStats, undefined)
    const statsResponse = await fetch(`${base}session-trace?sessionId=${statsOnlyId}`, { headers })
    assert.equal(statsResponse.status, 200)
    const savedStats = await statsResponse.json()
    assert.deepEqual(savedStats.sourceStats, sourceStats)
    assert.deepEqual(savedStats.trace, [])
    assert.equal((await fetch(`${base}session-trace?sessionId=${traceSessionId}`, {
      headers: { Cookie: 'signed-in=guest' },
    })).status, 403)
    const withTrace = await api({
      action: 'export-session', sessionId: traceSessionId, includeTrace: true,
      conversation: { ...conversation, trace: [{ kind: 'tool_result', text: 'spoofed-result' }] },
    })
    assert.equal(withTrace.status, 200)
    const { markdown } = await withTrace.json()
    assert.match(markdown, /^## 来源记录$/m)
    assert.match(markdown, /bridge-trace-result/)
    assert.doesNotMatch(markdown, /spoofed-result|bridge-trace-arguments/)
    assert.equal((await api({
      action: 'export-session', sessionId: detachedId, includeTrace: true, conversation,
    })).status, 404)

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
