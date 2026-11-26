import { open } from 'node:fs/promises'
import path from 'node:path'
import { authorizeProjectReference, verifySourceAuthorization } from './assets.js'
import { redact } from './handoff.js'

export async function readConversationAttachment(project, archive, item) {
  if (!item.path) return
  const candidate = path.isAbsolute(item.path) ? path.normalize(item.path) : path.resolve(project.cwd, item.path)
  let withinScope = false
  for (const root of [project.cwd, path.join(path.dirname(archive.file), 'attachments')]) {
    if (!root || !path.isAbsolute(root)) continue
    const relative = path.relative(root, candidate)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
    withinScope = true
    const href = relative.split(path.sep).map(encodeURIComponent).join('/')
    const proof = await authorizeProjectReference(root, path.join(root, '.conversation'), href)
    if (!proof.authorization) continue
    const handle = await open(candidate, 'r').catch(() => undefined)
    if (!handle) continue
    try {
      const initial = await handle.stat({ bigint: true })
      const current = await verifySourceAuthorization(proof.authorization)
      if (initial.dev !== current.fileInfo.dev || initial.ino !== current.fileInfo.ino) continue
      if (initial.size > 32n * 1024n * 1024n) return { details: { status: 'attachment-too-large' } }
      const bytes = Buffer.alloc(Number(initial.size))
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      const end = await handle.stat({ bigint: true })
      await verifySourceAuthorization(proof.authorization)
      if (offset === bytes.length && end.size === initial.size && end.mtimeNs === initial.mtimeNs && end.ctimeNs === initial.ctimeNs) {
        return { bytes, details: { name: redact(path.basename(candidate)) } }
      }
    } catch { /* Source identity changed during the read. */ }
    finally { await handle.close() }
  }
  return { details: { status: withinScope ? 'attachment-unavailable' : 'outside-project' } }
}
