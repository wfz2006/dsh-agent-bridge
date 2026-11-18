import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createCatalog } from './catalog.js'
import { loadConfig } from './config.js'
import { nativeSessionServices, saveNativeSession } from './session-import.js'
import { countTrace, isSessionId, readSessionTrace } from './session-trace.js'
import { createSkillBridge } from './skill-provider.js'

export const name = 'dsh-agent-bridge'
export const inject = {
  connection: true, webServer: true,
  sessions: false, sessionPersistence: false, workspaceRegistry: false, sessionProjectionCache: false,
  skills: false,
}

const prefix = '/agent-bridge'
const pageHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
}

function respond(res, status, type, value) {
  res.writeHead(status, { ...pageHeaders, 'Content-Type': type })
  res.end(value)
}

function json(res, status, data) {
  respond(res, status, 'application/json; charset=utf-8', JSON.stringify(data))
}

function isLoopback(address) {
  return typeof address === 'string' && (address === '::1' || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(address))
}

async function readBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > 192 * 1024) {
      const error = new Error('请求过大。')
      error.status = 413
      // Drain without buffering, so the client can receive a normal error response.
      req.resume()
      throw error
    }
    chunks.push(chunk)
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
    return data
  } catch {
    const error = new Error('请求格式无效。')
    error.status = 400
    throw error
  }
}

export function apply(ctx) {
  const services = () => nativeSessionServices(ctx)
  const skillHandoff = ctx.get?.('skills') ? createSkillBridge(ctx) : undefined
  async function loadSourceRecord(sessionId) {
    if (!isSessionId(sessionId)) throw Object.assign(new Error('会话标识无效。'), { status: 400 })
    const session = await ctx.get?.('sessionPersistence')?.stat?.(sessionId)
    if (session?.header?.id !== sessionId) {
      throw Object.assign(new Error('找不到这条 DSH 会话。'), { status: 404 })
    }
    const saved = await readSessionTrace(await loadConfig(), sessionId)
    if (!saved?.trace?.length && !saved?.sourceStats) {
      throw Object.assign(new Error('没有为这条会话保存来源记录。'), { status: 404 })
    }
    return { ...saved, traceCounts: countTrace(saved.trace) }
  }
  const catalog = createCatalog(loadConfig, {
    importConversation(record, cwd) {
      const host = services()
      if (!host) throw Object.assign(new Error('当前 DSH 未提供会话迁入服务。'), { status: 409 })
      return saveNativeSession(host, record, cwd)
    },
    skillHandoff,
    loadSourceRecord,
  })
  ctx.effect(() => () => catalog.dispose())
  const nonce = randomBytes(32).toString('hex')
  const staticRoutes = [
    ['/panel', 'panel.html', 'text/html; charset=utf-8'],
    ['/panel.css', 'panel.css', 'text/css; charset=utf-8'],
    ['/panel.js', 'panel.js', 'text/javascript; charset=utf-8'],
    ['/project-context.js', 'project-context.js', 'text/javascript; charset=utf-8'],
    ['/markdown.js', 'markdown.js', 'text/javascript; charset=utf-8'],
    ['/vendor/markdown-it.mjs', 'vendor/markdown-it.mjs', 'text/javascript; charset=utf-8'],
    ['/geist-latin-wght-normal.woff2', 'geist-latin-wght-normal.woff2', 'font/woff2'],
  ]
  const agentIcons = Object.create(null)
  const iconsDirectory = new URL('../web/agent-icons/', import.meta.url)
  if (existsSync(iconsDirectory)) {
    for (const entry of readdirSync(iconsDirectory, { withFileTypes: true })) {
      const match = /^([a-z][a-z0-9-]*)\.(svg|png)$/.exec(entry.name)
      if (!entry.isFile() || !match) continue
      const [, agent, extension] = match
      const file = `agent-icons/${entry.name}`
      agentIcons[agent] = file
      staticRoutes.push([`/${file}`, file, extension === 'svg' ? 'image/svg+xml' : 'image/png'])
    }
  }
  function register(path, method, action) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: prefix + path,
      async handler(req, res) {
        if (!isLoopback(req.socket.remoteAddress)
          || ctx.connection.admit?.(req)?.peer?.principal?.kind !== 'owner') {
          json(res, 403, { error: '请使用本机 DSH 所有者身份打开 Agent 接续。' })
          return
        }
        if (req.method !== method) {
          res.setHeader('Allow', method)
          json(res, 405, { error: '请求方法不受支持。' })
          return
        }
        try {
          await action(req, res)
        } catch (error) {
          if (!res.headersSent) json(res, error.status || 500, {
            error: error.status ? error.message : '无法读取本地资料。请检查 agent-bridge.json 和文件权限后刷新。',
          })
        }
      },
    }))
  }
  for (const [path, file, type] of staticRoutes) {
    register(path, 'GET', async (_req, res) => {
      const body = await readFile(new URL(`../web/${file}`, import.meta.url))
      respond(res, 200, type, file === 'panel.html' ? body.toString('utf8').replace('__DSH_BRIDGE_NONCE__', nonce) : body)
    })
  }
  register('/api', 'POST', async (req, res) => {
    if (req.headers['x-dsh-agent-bridge'] !== nonce
      || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      json(res, 403, { error: '面板已过期。重新打开 Agent 接续后重试。' })
      return
    }
    const input = await readBody(req)
    const conversationAction = ['list-conversations', 'preview-conversation', 'import-conversation'].includes(input.action)
    const nativeSessionImport = (conversationAction || input.action === 'catalog') && Boolean(services())
    if (conversationAction && !nativeSessionImport) {
      json(res, 403, { error: '请在支持会话迁入的本机 DSH 主界面中使用。' })
      return
    }
    const result = await catalog.execute(input.action, input)
    json(res, 200, input.action === 'catalog' ? { ...result, agentIcons, nativeSessionImport } : result)
  })
  register('/session-trace', 'GET', async (req, res) => {
    const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? ''
    json(res, 200, await loadSourceRecord(sessionId))
  })
}
