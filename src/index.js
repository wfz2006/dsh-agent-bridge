import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createCatalog } from './catalog.js'
import { loadConfig } from './config.js'

export const name = 'dsh-agent-bridge'
export const inject = ['connection', 'webServer']

const prefix = '/agent-bridge'
const pageHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
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
  const catalog = createCatalog(loadConfig)
  ctx.effect(() => () => catalog.dispose())
  const nonce = randomBytes(32).toString('hex')
  const staticRoutes = [
    ['/panel', 'panel.html', 'text/html; charset=utf-8'],
    ['/panel.css', 'panel.css', 'text/css; charset=utf-8'],
    ['/panel.js', 'panel.js', 'text/javascript; charset=utf-8'],
    ['/geist-latin-wght-normal.woff2', 'geist-latin-wght-normal.woff2', 'font/woff2'],
  ]
  function register(path, method, action) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: prefix + path,
      async handler(req, res) {
        if (!isLoopback(req.socket.remoteAddress) || ctx.connection.requestRejection(req) !== undefined) {
          json(res, 403, { error: '请在这台电脑上打开已登录的 DSH。' })
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
    const result = await catalog.execute(input.action, input)
    json(res, 200, result)
  })
}
