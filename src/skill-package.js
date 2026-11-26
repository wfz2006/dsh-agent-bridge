import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { verifySourceAuthorization } from './assets.js'

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const PACKAGE_MAX_FILES = 1000
export const PACKAGE_MAX_BYTES = 25 * 1024 * 1024
const skipNames = new Set(['.git', '.DS_Store'])
const scriptName = /\.(?:sh|bash|zsh|fish|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|lua)$/i
const credentialName = /^(?:\.env(?:\..+)?|\.git-credentials|\.netrc|\.npmrc|\.pypirc|auth\.json|credentials\.json|secrets\.json|id_(?:ecdsa|ed25519|rsa))$|\.(?:key|p12|pem|pfx)$/i
const safeEnvExample = /^\.env\.(?:example|sample|template)$/i

export class SkillPackageError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'SkillPackageError'
    this.code = code
    this.details = details
  }
}

function pathKey(file) {
  const normalized = path.normalize(file)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function relativePath(root, file) {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
    ? relative : undefined
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function changed() {
  return new SkillPackageError('source-changed', 'The skill source changed while it was being read.')
}

function protectName(name) {
  if (credentialName.test(name) && !safeEnvExample.test(name)) {
    throw new SkillPackageError('sensitive-file', 'A skill package contains a credential-like file and was not copied.')
  }
}

function yamlScalar(text) {
  const raw = text.trim()
  const quote = raw[0]
  if (quote !== '"' && quote !== "'") return raw.replace(/[ \t]+#.*$/, '').trimEnd()
  const pairs = quote === '"' ? /^"((?:[^"\\]|\\.)*)"[ \t]*(?:#.*)?$/ : /^'((?:[^']|'')*)'[ \t]*(?:#.*)?$/
  const match = pairs.exec(raw)
  if (!match) throw new SkillPackageError('invalid-frontmatter', 'The skill contains a malformed quoted value.')
  if (quote === "'") return match[1].replaceAll("''", "'")
  const escapes = {
    '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
    ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
  }
  return match[1].replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, escaped) => {
    if (Object.hasOwn(escapes, escaped)) return escapes[escaped]
    const codepoint = escaped.length > 1 ? Number.parseInt(escaped.slice(1), 16) : -1
    if (codepoint < 0 || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
      throw new SkillPackageError('invalid-frontmatter', 'The skill contains an unsupported YAML escape.')
    }
    return String.fromCodePoint(codepoint)
  })
}

function blockScalar(rows, mode) {
  const indent = rows.reduce((min, line) => line.trim() ? Math.min(min, line.match(/^[ \t]*/)[0].length) : min, Infinity)
  const dedented = rows.map(line => line.slice(indent))
  if (mode === '|') return dedented.join('\n')
  return dedented.reduce((value, line, index) => {
    const previous = dedented[index - 1]
    const separator = previous === undefined ? '' : previous && line ? ' ' : '\n'
    return value + separator + line
  }, '')
}

const fieldPattern = /^([A-Za-z_][\w.-]*|"[^"\\]*(?:\\.[^"\\]*)*"|'(?:[^']|'')*')[ \t]*:[ \t]*(.*)$/
const spaces = line => line.match(/^[ \t]*/)[0].length
const policyKeys = new Set(['disable-model-invocation', 'user-invocable'])

function metadataValue(value, children) {
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* Non-JSON flow mappings are outside the supported metadata subset. */ }
    return undefined
  }
  if (value || !children.length) return undefined
  const metadata = Object.create(null)
  const indent = spaces(children[0])
  for (const line of children) {
    const entry = fieldPattern.exec(line.slice(indent))
    if (spaces(line) !== indent || !entry || !entry[2]) return undefined
    const key = yamlScalar(entry[1])
    if (Object.hasOwn(metadata, key)) return undefined
    const scalar = yamlScalar(entry[2])
    if (/^[\[{&*!|>]/.test(scalar) && !/^[\"']/.test(entry[2])) return undefined
    if (/^[\"']/.test(entry[2])) metadata[key] = scalar
    else if (/^(?:null|~)$/i.test(scalar)) metadata[key] = null
    else if (/^(?:true|false)$/i.test(scalar)) metadata[key] = scalar.toLowerCase() === 'true'
    else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(scalar) && Number.isFinite(Number(scalar))) {
      metadata[key] = Number(scalar)
    } else metadata[key] = scalar
  }
  return metadata
}

export function parseSkillFile(text) {
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(text)
  const fields = Object.create(null)
  if (!opening) return { fields, body: text }
  const boundary = /^---[ \t]*(?:\r?\n|$)/gm
  boundary.lastIndex = opening[0].length
  const end = boundary.exec(text)
  if (!end) return { fields, body: text }
  const header = text.slice(opening[0].length, end.index)
  const rows = header.replace(/\r?\n$/, '').split(/\r?\n/)
  const meaningful = line => Boolean(line.trim() && !line.trimStart().startsWith('#'))
  const indent = rows.reduce((min, line) => meaningful(line) ? Math.min(min, spaces(line)) : min, Infinity)
  for (let row = 0; row < rows.length; row++) {
    if (!meaningful(rows[row])) continue
    const property = spaces(rows[row]) === indent && fieldPattern.exec(rows[row].slice(indent))
    if (!property) {
      throw new SkillPackageError('invalid-frontmatter', 'The skill frontmatter contains an unsupported YAML field or policy.')
    }
    const key = yamlScalar(property[1])
    const value = property[2].trimEnd()
    if (Object.hasOwn(fields, key) || key === '<<') {
      throw new SkillPackageError('invalid-frontmatter', 'The skill frontmatter contains a duplicate field or YAML merge.')
    }
    const children = []
    while (row + 1 < rows.length && (!meaningful(rows[row + 1]) || spaces(rows[row + 1]) > indent)) {
      children.push(rows[++row])
    }
    const operator = /^([|>])([+-]?)[ \t]*(?:#.*)?$/.exec(value)
    if (key === 'metadata') {
      fields[key] = metadataValue(value, children.filter(meaningful))
    } else if (operator) {
      const block = blockScalar(children.filter(line => !line.trim() || spaces(line) > indent), operator[1])
      fields[key] = operator[2] === '+' ? block : block.trimEnd()
    } else {
      if (policyKeys.has(key) && children.some(meaningful)) {
        throw new SkillPackageError('invalid-invocation', 'The skill invocation policy must use a scalar value.')
      }
      fields[key] = yamlScalar(value)
    }
  }
  return { fields, body: text.slice(boundary.lastIndex) }
}

function readInvocation(fields) {
  function flag(name, fallback) {
    if (!Object.hasOwn(fields, name)) return fallback
    const value = fields[name].toLowerCase()
    if (/^(?:true|yes|on|1)$/.test(value)) return true
    if (/^(?:false|no|off|0)$/.test(value)) return false
    throw new SkillPackageError('invalid-invocation', 'Frontmatter ' + name + ' must be a boolean.')
  }
  if (['disableModelInvocation', 'modelInvocable', 'userInvocable'].some(name => Object.hasOwn(fields, name))) {
    throw new SkillPackageError('invalid-invocation', 'Skill invocation fields must use kebab-case.')
  }
  return { modelInvocable: !flag('disable-model-invocation', false), userInvocable: flag('user-invocable', true) }
}

export function skillLocation(file) {
  return { layout: path.basename(file) === 'SKILL.md' ? 'directory' : 'flat', root: path.dirname(file), file }
}

async function scanFile(root, entry, info, rel) {
  const target = await realpath(entry)
  const relative = relativePath(root, target)
  if (relative === undefined) throw new SkillPackageError('unsafe-link', 'A skill links outside its package.')
  if (info.isSymbolicLink()) {
    relative.split(path.sep).forEach(protectName)
    info = await lstat(target, { bigint: true })
    if (!info.isFile()) throw new SkillPackageError('unsafe-link', 'A skill link must resolve to a regular file.')
  } else if (pathKey(entry) !== pathKey(target)) throw changed()
  if (!info.isFile() || info.nlink !== 1n) {
    throw new SkillPackageError('unsafe-file', 'Skill files must be regular files without hard links.')
  }
  return { entry, path: target, rel, script: scriptName.test(rel), info }
}

async function readChecked(root, rootInfo, file) {
  async function checkPath() {
    const now = await lstat(root, { bigint: true })
    if (!now.isDirectory() || now.dev !== rootInfo.dev || now.ino !== rootInfo.ino
      || pathKey(await realpath(root)) !== pathKey(root)
      || pathKey(await realpath(file.entry)) !== pathKey(file.path)) throw changed()
  }
  let handle
  try {
    await checkPath()
    handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || !sameIdentity(before, file.info)) throw changed()
    const size = Number(before.size)
    if (size > PACKAGE_MAX_BYTES) throw packageLimit()
    const bytes = Buffer.allocUnsafe(size)
    let progress = 0
    while (progress < size) {
      const { bytesRead } = await handle.read(bytes, progress, size - progress, progress)
      if (!bytesRead) throw changed()
      progress += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    await checkPath()
    if (after.nlink !== 1n || !sameIdentity(before, after)
      || !sameIdentity(after, await lstat(file.path, { bigint: true }))) throw changed()
    return bytes
  } catch (error) {
    if (error instanceof SkillPackageError) throw error
    throw changed()
  } finally {
    await handle?.close()
  }
}

function packageLimit() {
  return new SkillPackageError('package-too-large', 'The skill is too large to copy safely.', {
    files: PACKAGE_MAX_FILES, bytes: PACKAGE_MAX_BYTES,
  })
}

async function inventory(root, skillFile, layout) {
  const files = []
  let bytes = 0
  function remember(file) {
    bytes += Number(file.info.size)
    if (bytes > PACKAGE_MAX_BYTES || files.length >= PACKAGE_MAX_FILES) throw packageLimit()
    files.push(file)
  }
  if (layout === 'flat') {
    remember(await scanFile(root, skillFile, await lstat(skillFile, { bigint: true }), 'SKILL.md'))
    return { files, bytes }
  }
  const visit = async directory => {
    if (pathKey(await realpath(directory)) !== pathKey(directory)) throw changed()
    for (const name of (await readdir(directory)).sort()) {
      if (skipNames.has(name)) continue
      protectName(name)
      const entry = path.join(directory, name)
      const info = await lstat(entry, { bigint: true })
      if (info.isDirectory()) await visit(entry)
      else {
        const rel = path.relative(root, entry).split(path.sep).join('/')
        remember(await scanFile(root, entry, info, rel))
      }
    }
    if (pathKey(await realpath(directory)) !== pathKey(directory)) throw changed()
  }
  await visit(root)
  return { files, bytes }
}

async function sourceLocation(file, authorization) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new SkillPackageError('invalid-path', 'The skill path is not absolute.')
  }
  const location = skillLocation(file)
  try {
    const authorized = authorization && await verifySourceAuthorization(authorization)
    if (authorized && (authorized.file !== file || authorized.directory !== location.root)) {
      throw new SkillPackageError('unsafe-path', 'The skill authorization does not match this package.')
    }
    const root = authorized?.directory ?? await realpath(location.root)
    const rootInfo = await lstat(root, { bigint: true })
    if (!rootInfo.isDirectory()) throw new SkillPackageError('unsafe-path', 'The skill root is not a directory.')
    const skillFile = path.join(root, path.basename(file))
    await lstat(skillFile)
    return { root, rootInfo, skillFile, layout: location.layout }
  } catch (error) {
    if (error instanceof SkillPackageError) throw error
    if (error?.code === 'ASSET_SOURCE_CHANGED') throw changed()
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new SkillPackageError('missing', 'The skill file or folder no longer exists.')
    }
    throw new SkillPackageError('unreadable-package', 'The skill package could not be inspected.')
  }
}

export async function readSkillPackage(file, { content = false, authorization } = {}) {
  const { root, rootInfo, skillFile, layout } = await sourceLocation(file, authorization)
  let manifest
  try { manifest = await inventory(root, skillFile, layout) }
  catch (error) {
    if (error instanceof SkillPackageError) throw error
    throw new SkillPackageError('unreadable-package', 'The skill package could not be inspected.')
  }
  const { files, bytes } = manifest
  const instruction = files.find(entry => entry.rel === 'SKILL.md')
  if (!instruction) throw new SkillPackageError('missing', 'SKILL.md is missing from the package.')
  const instructions = await readChecked(root, rootInfo, instruction)
  const { fields, body } = parseSkillFile(instructions.toString('utf8'))
  const name = fields.name?.trim()
  const description = fields.description?.trim()
  if (!name || !description) throw new SkillPackageError('invalid-frontmatter', 'SKILL.md needs name and description frontmatter.')
  if (!SKILL_NAME.test(name)) throw new SkillPackageError('invalid-name', 'The skill name is not valid kebab-case.')
  const invocation = readInvocation(fields)
  const metadata = createHash('sha256')
  const contents = content ? createHash('sha256') : undefined
  const resources = { scripts: 0, references: 0, assets: 0 }

  // The on-disk activation receipts use these version-1 fingerprint encodings.
  // Preserve the sorted depth-first order, slash form and field delimiters.
  for (const entry of files) {
    metadata.update(entry.rel).update('\0' + entry.info.size + '\0' + entry.info.mtimeNs + '\n')
    const folder = entry.rel.split('/')[0]
    if (Object.hasOwn(resources, folder) && entry.rel.includes('/')) resources[folder]++
    if (contents) {
      const data = entry === instruction ? instructions : await readChecked(root, rootInfo, entry)
      contents.update(entry.rel).update('\0').update(data).update('\n')
    }
  }
  if (authorization) {
    try { await verifySourceAuthorization(authorization) } catch { throw changed() }
  }
  return {
    layout, name, description, invocation, body: body.trim(),
    ...(fields.whenToUse?.trim() ? { whenToUse: fields.whenToUse.trim() } : {}),
    ...(fields.metadata ? { metadata: fields.metadata } : {}),
    sourceFile: file, sourceRoot: root, skillFile: instruction.path,
    ...(authorization ? { authorization } : {}),
    files, fileCount: files.length, bytes, resources,
    quickHash: metadata.digest('hex'),
    ...(contents ? { contentHash: contents.digest('hex') } : {}),
    hasScripts: resources.scripts > 0 || files.some(entry => entry.script),
    scriptFiles: files.filter(entry => entry.script).slice(0, 20).map(entry => entry.rel),
  }
}

export async function sourceState(file, recorded, { authorization } = {}) {
  try {
    const current = await readSkillPackage(file, { authorization })
    if (current.quickHash === recorded?.quickHash && recorded?.contentHash !== undefined) return 'same'
    const verified = await readSkillPackage(file, { content: true, authorization })
    return verified.contentHash === recorded?.contentHash ? 'same' : 'changed'
  } catch (error) {
    if (!(error instanceof SkillPackageError)) throw error
    return error.code === 'missing' ? 'missing' : 'invalid'
  }
}

async function publishDirectory(staging, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(staging, destination)
      return
    } catch (error) {
      if (attempt === 5 || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code)) throw error
      await delay(40 * (attempt + 1))
    }
  }
}

export async function copySkillPackage(snapshot, destination) {
  if (snapshot.layout !== 'directory') throw new SkillPackageError('flat-package', 'Only directory skill bundles can be enabled.')
  const current = await readSkillPackage(snapshot.sourceFile, { content: true, authorization: snapshot.authorization })
  if (current.contentHash !== snapshot.contentHash || current.quickHash !== snapshot.quickHash) throw changed()
  const { sourceRoot: root } = current
  const rootInfo = await lstat(root, { bigint: true })
  await mkdir(path.dirname(destination), { recursive: true })
  const stage = await mkdtemp(destination + '.part-')
  let committed = false
  try {
    for (const file of current.files) {
      const target = path.join(stage, ...file.rel.split('/'))
      if (!relativePath(stage, target)) throw new SkillPackageError('unsafe-path', 'A skill file leaves its destination.')
      const bytes = await readChecked(root, rootInfo, file)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
      if (process.platform !== 'win32') {
        const handle = await open(target, 'r')
        try { await handle.chmod(Number(file.info.mode) & 0o777) } finally { await handle.close() }
      }
    }
    const copied = await readSkillPackage(path.join(stage, 'SKILL.md'), { content: true })
    if (copied.contentHash !== snapshot.contentHash || copied.fileCount !== snapshot.fileCount) throw changed()
    await publishDirectory(stage, destination)
    committed = true
    return copied
  } finally {
    if (!committed && path.dirname(stage) === path.dirname(destination)) {
      await rm(stage, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export function snapshotIdFor(name, contentHash) {
  return name + '-' + contentHash.slice(0, 16)
}
