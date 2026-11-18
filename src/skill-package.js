import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { verifySourceAuthorization } from './assets.js'

// File discovery, frontmatter parsing, and package limits are adapted from
// dsh-mode-skills commit 706595127984c9bc87627f77d2a8e288b8dcbbbb
// (MIT). See THIRD_PARTY_NOTICES.md.

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const PACKAGE_MAX_FILES = 1000
export const PACKAGE_MAX_BYTES = 25 * 1024 * 1024
const SKIPPED = new Set(['.git', '.DS_Store'])
const SENSITIVE_NAMES = new Set([
  '.env', '.git-credentials', '.netrc', '.npmrc', '.pypirc',
  'auth.json', 'credentials.json', 'id_ecdsa', 'id_ed25519', 'id_rsa', 'secrets.json',
])
const SENSITIVE_EXTENSIONS = new Set(['.key', '.p12', '.pem', '.pfx'])
const SCRIPT_EXTENSIONS = new Set([
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.py',
  '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php', '.lua',
])

export class SkillPackageError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'SkillPackageError'
    this.code = code
    this.details = details
  }
}

function pathKey(value) {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathInside(root, file) {
  const relative = path.relative(pathKey(root), pathKey(file))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function unquote(value) {
  const text = value.trim()
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'")))) {
    return text.startsWith('"')
      ? text.slice(1, -1).replace(/\\(["\\nt])/g, (_, escaped) => ({ n: '\n', t: '\t' })[escaped] ?? escaped)
      : text.slice(1, -1).replaceAll("''", "'")
  }
  return text
}

export function parseSkillFile(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (match === null) return { fields: {}, body: text }
  const fields = {}
  const lines = match[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = /^([A-Za-z][\w-]*):(?:[ \t]+(.*))?$/.exec(lines[index])
    if (line === null) continue
    const [, key, raw = ''] = line
    const block = /^([|>])([+-]?)\s*$/.exec(raw.trim())
    if (block === null) {
      if (raw.trim() !== '') fields[key] = unquote(raw)
      continue
    }
    const collected = []
    while (index + 1 < lines.length && (lines[index + 1].trim() === '' || /^[ \t]/.test(lines[index + 1]))) {
      collected.push(lines[++index])
    }
    const indent = Math.min(...collected.filter(entry => entry.trim() !== '')
      .map(entry => /^[ \t]*/.exec(entry)[0].length))
    const rows = collected.map(entry => entry.slice(Number.isFinite(indent) ? indent : 0))
    const joined = block[1] === '|' ? rows.join('\n') : rows.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ')
    fields[key] = block[2] === '+' ? joined : joined.replace(/\s+$/, '')
  }
  return { fields, body: text.slice(match[0].length) }
}

function frontmatterBoolean(fields, key) {
  if (!Object.hasOwn(fields, key)) return undefined
  const value = fields[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    if (['true', 'yes', 'on'].includes(normalized)) return true
    if (['false', 'no', 'off'].includes(normalized)) return false
  }
  throw new SkillPackageError('invalid-invocation', `Frontmatter ${key} must be a boolean.`)
}

function invocationPolicy(fields) {
  if (Object.hasOwn(fields, 'disableModelInvocation') || Object.hasOwn(fields, 'modelInvocable')
    || Object.hasOwn(fields, 'userInvocable')) {
    throw new SkillPackageError('invalid-invocation', 'Skill invocation fields must use the kebab-case names.')
  }
  const modelDisabled = frontmatterBoolean(fields, 'disable-model-invocation')
  const userDisabled = frontmatterBoolean(fields, 'user-invocable')
  return {
    modelInvocable: modelDisabled !== true,
    userInvocable: userDisabled !== false,
  }
}

export function skillLocation(file) {
  return path.basename(file) === 'SKILL.md'
    ? { layout: 'directory', root: path.dirname(file), file }
    : { layout: 'flat', root: path.dirname(file), file }
}

async function stableFileBuffer(file, expected) {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size !== expected.size
      || before.dev !== expected.dev || before.ino !== expected.ino) {
      throw new SkillPackageError('source-changed', 'A skill file changed while it was being read.')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || BigInt(bytes.length) !== after.size) {
      throw new SkillPackageError('source-changed', 'A skill file changed while it was being read (read).')
    }
    return bytes
  } finally {
    await handle?.close()
  }
}

async function walkPackage(base, directory, files, totals) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    throw new SkillPackageError('unreadable-package', `Cannot read skill directory: ${error.message}`)
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  for (const entry of entries) {
    if (SKIPPED.has(entry.name)) continue
    const lowerName = entry.name.toLowerCase()
    const envFile = lowerName.startsWith('.env.')
      && !['.env.example', '.env.sample', '.env.template'].includes(lowerName)
    if (SENSITIVE_NAMES.has(lowerName) || envFile
      || SENSITIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      throw new SkillPackageError('sensitive-file', 'A skill package contains a credential-like file and was not copied.')
    }
    const candidate = path.join(directory, entry.name)
    let info
    try {
      info = await lstat(candidate, { bigint: true })
    } catch (error) {
      throw new SkillPackageError('unreadable-package', `Cannot inspect skill file: ${error.message}`)
    }
    let source = candidate
    let type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'link' : 'other'
    if (type === 'link') {
      let target
      try {
        target = await realpath(candidate)
      } catch {
        throw new SkillPackageError('unsafe-link', 'A skill contains a broken link.')
      }
      if (!isPathInside(base, target)) {
        throw new SkillPackageError('unsafe-link', 'A skill links outside its package.')
      }
      const targetInfo = await stat(target, { bigint: true }).catch(() => undefined)
      if (targetInfo?.isFile()) {
        source = target
        info = targetInfo
        type = 'file'
      } else if (targetInfo?.isDirectory()) {
        throw new SkillPackageError('unsafe-link', 'A skill directory link is not accepted.')
      } else {
        throw new SkillPackageError('unsafe-link', 'A skill contains an unsupported link.')
      }
    }
    const relative = path.relative(base, candidate)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new SkillPackageError('unsafe-path', 'A skill path leaves its package.')
    }
    if (type === 'directory') {
      await walkPackage(base, candidate, files, totals)
      continue
    }
    if (type !== 'file') {
      throw new SkillPackageError('special-file', 'A skill contains a special file.')
    }
    totals.files++
    totals.bytes += Number(info.size)
    if (totals.files > PACKAGE_MAX_FILES || totals.bytes > PACKAGE_MAX_BYTES) {
      throw new SkillPackageError('package-too-large', 'The skill is too large to copy safely.', {
        files: PACKAGE_MAX_FILES,
        bytes: PACKAGE_MAX_BYTES,
      })
    }
    const extension = path.extname(relative).toLowerCase()
    files.push({
      path: source,
      rel: relative.split(path.sep).join('/'),
      size: info.size,
      mtimeNs: info.mtimeNs,
      dev: info.dev,
      ino: info.ino,
      mode: Number(info.mode),
      script: SCRIPT_EXTENSIONS.has(extension),
    })
  }
}

function hashFiles(files, buffers) {
  const content = createHash('sha256')
  for (const file of files) {
    content.update(file.rel)
    content.update('\0')
    content.update(buffers.get(file.rel))
    content.update('\n')
  }
  return content.digest('hex')
}

function quickHash(files) {
  const quick = createHash('sha256')
  for (const file of files) {
    quick.update(`${file.rel}\0${file.size}\0${file.mtimeNs}\n`)
  }
  return quick.digest('hex')
}

function resourceSummary(files) {
  const resources = { scripts: 0, references: 0, assets: 0 }
  for (const file of files) {
    if (file.rel.startsWith('scripts/')) resources.scripts++
    else if (file.rel.startsWith('references/')) resources.references++
    else if (file.rel.startsWith('assets/')) resources.assets++
  }
  return resources
}

/**
 * Read a skill directory bundle without following links outside it.
 * Content is read only when requested, while the quick hash always comes from
 * the stable path/size/mtime list.
 */
export async function readSkillPackage(file, { content = false, authorization } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new SkillPackageError('invalid-path', 'The skill path is not absolute.')
  }
  const location = skillLocation(file)
  let base
  let skillFile
  let skillInfo
  try {
    if (authorization) {
      if (authorization.file !== file || authorization.directory !== location.root) {
        throw new SkillPackageError('unsafe-path', 'The skill authorization does not match this package.')
      }
      const verified = await verifySourceAuthorization(authorization)
      base = verified.directory
      skillFile = verified.file
      skillInfo = verified.fileInfo
    } else {
      base = await realpath(location.root)
      skillFile = await realpath(location.file)
    }
  } catch (error) {
    if (error instanceof SkillPackageError) throw error
    if (error?.code === 'ASSET_SOURCE_CHANGED') {
      throw new SkillPackageError('source-changed', 'The skill source changed or left its authorized root.')
    }
    throw new SkillPackageError('missing', 'The skill file or folder no longer exists.')
  }
  if (!isPathInside(base, skillFile) || !(await stat(skillFile)).isFile()) {
    throw new SkillPackageError('unsafe-path', 'The skill file cannot be resolved inside its package.')
  }
  skillInfo ??= await lstat(skillFile, { bigint: true })
  if (!skillInfo.isFile() || skillInfo.nlink > 1n) {
    throw new SkillPackageError('unsafe-file', 'SKILL.md must be a regular file.')
  }
  const skillText = (await stableFileBuffer(skillFile, skillInfo)).toString('utf8')
  const parsed = parseSkillFile(skillText)
  const name = typeof parsed.fields.name === 'string' ? parsed.fields.name.trim() : ''
  const description = typeof parsed.fields.description === 'string' ? parsed.fields.description.trim() : ''
  if (!name || !description) {
    throw new SkillPackageError('invalid-frontmatter', 'SKILL.md needs name and description frontmatter.')
  }
  if (!SKILL_NAME.test(name)) {
    throw new SkillPackageError('invalid-name', 'The skill name is not valid kebab-case.')
  }
  const invocation = invocationPolicy(parsed.fields)

  const files = []
  const totals = { files: 0, bytes: 0 }
  if (location.layout === 'directory') {
    await walkPackage(base, base, files, totals)
    if (!files.some(entry => entry.rel === 'SKILL.md')) {
      throw new SkillPackageError('missing', 'SKILL.md is missing from the package list.')
    }
  } else {
    files.push({
      path: skillFile,
      rel: 'SKILL.md',
      size: skillInfo.size,
      mtimeNs: skillInfo.mtimeNs,
      dev: skillInfo.dev,
      ino: skillInfo.ino,
      mode: Number(skillInfo.mode),
      script: false,
    })
    totals.files = 1
    totals.bytes = Number(skillInfo.size)
  }
  const buffers = new Map()
  let contentHash
  if (content) {
    for (const entry of files) {
      buffers.set(entry.rel, await stableFileBuffer(entry.path, entry))
    }
    contentHash = hashFiles(files, buffers)
  }
  const resources = resourceSummary(files)
  return {
    layout: location.layout,
    name,
    description,
    invocation,
    body: parsed.body.trim(),
    sourceFile: file,
    ...(authorization ? { authorization } : {}),
    sourceRoot: base,
    skillFile,
    files,
    fileCount: files.length,
    bytes: totals.bytes,
    quickHash: quickHash(files),
    ...(contentHash === undefined ? {} : { contentHash }),
    resources,
    hasScripts: resources.scripts > 0 || files.some(entry => entry.script),
    scriptFiles: files.filter(entry => entry.script).map(entry => entry.rel).slice(0, 20),
  }
}

export async function sourceState(file, recorded, { authorization } = {}) {
  let current
  try {
    current = await readSkillPackage(file, { content: false, authorization })
  } catch (error) {
    if (error instanceof SkillPackageError && error.code === 'missing') return 'missing'
    if (error instanceof SkillPackageError) return 'invalid'
    throw error
  }
  if (recorded?.quickHash === current.quickHash && recorded?.contentHash !== undefined) return 'same'
  const full = await readSkillPackage(file, { content: true, authorization })
  return full.contentHash === recorded?.contentHash ? 'same' : 'changed'
}

/**
 * Copy a validated package snapshot into a fresh directory and verify the
 * destination before the caller makes it visible.
 */
export async function copySkillPackage(snapshot, destination) {
  if (snapshot.layout !== 'directory') {
    throw new SkillPackageError('flat-package', 'Only directory skill bundles can be enabled.')
  }
  const partial = `${destination}.partial-${process.pid}-${Date.now()}`
  await mkdir(path.dirname(destination), { recursive: true })
  try {
    await mkdir(partial, { recursive: true })
    const ordered = [...snapshot.files].sort((left, right) => {
      if (left.rel === 'SKILL.md') return 1
      if (right.rel === 'SKILL.md') return -1
      return left.rel.localeCompare(right.rel)
    })
    for (const file of ordered) {
      const target = path.join(partial, ...file.rel.split('/'))
      if (!isPathInside(partial, target)) {
        throw new SkillPackageError('unsafe-path', 'A skill file leaves its destination.')
      }
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, await stableFileBuffer(file.path, file))
      if (process.platform !== 'win32') await chmod(target, file.mode & 0o777)
    }
    const copied = await readSkillPackage(path.join(partial, 'SKILL.md'), { content: true })
    if (copied.contentHash !== snapshot.contentHash || copied.fileCount !== snapshot.fileCount) {
      throw new SkillPackageError('source-changed', 'The skill changed while its snapshot was being copied.')
    }
    await moveIntoPlace(partial, destination)
    return copied
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function moveIntoPlace(source, destination) {
  let last
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      last = error
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(error.code) || attempt === 5) break
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)))
    }
  }
  throw last
}

export function snapshotIdFor(name, contentHash) {
  return `${name}-${contentHash.slice(0, 16)}`
}
