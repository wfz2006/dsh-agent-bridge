import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

export async function saveOutput(file, chunks) {
  const target = path.resolve(file)
  const output = createWriteStream(target, { flags: 'wx', mode: 0o600 })
  let created = false
  output.once('open', () => { created = true })
  try {
    await pipeline(chunks, output)
    return target
  } catch (error) {
    if (created) await unlink(target).catch(() => {})
    if (error.code === 'EEXIST') throw new Error('输出文件已存在，请选择另一个文件名。')
    throw error
  }
}
