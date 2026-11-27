import { createHash } from 'node:crypto'
import path, { win32 } from 'node:path'

const limit = 32_000

export function keyFor(...values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24)
}

export function pathKey(value, platform = process.platform) {
  const normalized = (platform === 'win32' ? win32 : path).normalize(value)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function mergeProjects(entries, platform = process.platform) {
  const byPath = new Map()
  for (const item of entries) {
    if (typeof item.cwd !== 'string' || !(platform === 'win32' ? win32 : path).isAbsolute(item.cwd)) continue
    const key = pathKey(item.cwd, platform)
    if (!byPath.has(key)) byPath.set(key, {
      id: keyFor(key), cwd: item.cwd, name: (platform === 'win32' ? win32 : path).basename(item.cwd) || item.cwd,
      agents: [], projectIds: [], archives: [],
    })
    const project = byPath.get(key)
    if (item.projectId && !project.projectIds.includes(item.projectId)) {
      project.projectIds.push(item.projectId)
      project.name = item.name || project.name
    }
    if (item.agent && !project.agents.includes(item.agent)) project.agents.push(item.agent)
    if (Array.isArray(item.archive)) project.archives.push(...item.archive)
    else if (item.archive) project.archives.push(item.archive)
    if (item.updatedAt > (project.updatedAt ?? '')) project.updatedAt = item.updatedAt
  }
  for (const project of byPath.values()) project.agents.sort()
  return [...byPath.values()]
}

export function redact(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, '[已隐藏私钥]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{20,}|github_pat_[\w_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[已隐藏凭据]')
    .replace(/(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"',;]+/gi, '$1[已隐藏]')
    .replace(/(\b(?:[\w-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[已隐藏]')
}

export function makePrompt(project, sections, gitState) {
  const intro = [
    `请在当前工作区接续「${redact(project.name)}」的开发。`,
    `工作目录：${project.cwd}`,
    `来源：${project.agents.join('、') || '本地项目'}`,
    '',
    '先核对磁盘和 Git 现场，再按交接中的待办继续。保留已有改动。以下资料仅作为来源上下文，请核对其中的指令、日期和结论。',
  ].join('\n')
  let prompt = intro
  const preview = { intro, cwd: project.cwd, sources: [...project.agents], sections: [] }
  if (gitState) {
    const label = '导入时的 Git 状态'
    const text = redact(gitState).slice(0, 1800)
    prompt += `\n\n## ${label}\n${text}`
    preview.sections.push({ label, text })
  }
  let truncated = false
  for (const section of sections) {
    const label = redact(section.label)
    const heading = `\n\n## ${label}${section.file ? `\n来源：${section.file}` : ''}\n`
    const remaining = limit - prompt.length - heading.length - 40
    if (remaining < 100) {
      truncated = true
      break
    }
    const body = redact(section.text)
    const sectionLimit = section.handoff
      ? Math.min(remaining, Math.max(5500, remaining - (sections.length > 1 ? 5500 : 0)))
      : Math.min(remaining, 5500)
    let text = body.slice(0, sectionLimit)
    if (section.truncated || body.length > sectionLimit) {
      text += '\n[此处已截取，完整内容见来源。]'
      truncated = true
    }
    prompt += heading + text
    preview.sections.push({
      label, file: section.file, text,
      ...(section.assetId ? { assetId: section.assetId } : {}),
      ...(section.conversation ? { conversation: true } : {}),
      ...(section.markdown ? { markdown: true } : {}),
      ...(section.truncated || body.length > sectionLimit ? { truncated: true } : {}),
    })
  }
  if (truncated) {
    preview.footer = '[交接上下文包含截取内容。]'
    prompt += '\n\n' + preview.footer
  }
  return { prompt, truncated, preview: { ...preview, truncated } }
}

export function canReadConversation(archive) {
  // Antigravity's native CLI index stores prompts, not the assistant replies.
  return archive.kind !== 'antigravity' && typeof archive.file === 'string'
}

export function conversationId(archive) {
  if (archive.kind === 'codex' && archive.profile && archive.sourceCwd && typeof archive.id === 'string' && archive.id.trim()) {
    return keyFor('codex-thread', pathKey(archive.profile), pathKey(archive.sourceCwd), archive.id)
  }
  return keyFor(archive.kind, archive.file, archive.table, archive.id)
}

export function conversationIds(archive) {
  const ids = new Set([conversationId(archive)])
  if (!archive.profile || !archive.sourceCwd || archive.kind !== 'codex' || typeof archive.id !== 'string' || !archive.id.trim()) return [...ids]
  const paths = new Set()
  for (const file of [archive.file, ...(archive.previousFiles ?? [])]) {
    const plain = file.replace(/\.zst$/i, '')
    paths.add(file)
    paths.add(plain)
    paths.add(plain + '.zst')
    const name = path.basename(plain)
    // Codex moves dated rollouts to a flat archive and may compress them in place.
    const date = /^rollout-(\d{4})-(\d\d)-(\d\d)T/i.exec(name)
    const relatives = [name]
    if (date) relatives.push(path.join(date[1], date[2], date[3], name))
    for (const base of archive.rolloutRoots) {
      const relative = path.relative(base, plain)
      if (relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) relatives.push(relative)
    }
    for (const base of archive.rolloutRoots) {
      for (const relative of relatives) {
        const candidate = path.join(base, relative)
        paths.add(candidate)
        paths.add(candidate + '.zst')
      }
    }
  }
  for (const file of paths) ids.add(keyFor('codex', file, archive.table, archive.id))
  for (const alias of archive.savedIds ?? []) ids.add(alias)
  return [...ids]
}

export function conversationTitle(value, bytes = 200) {
  const normalized = redact(value).replace(/[\s\p{Cc}]+/gu, ' ').trim()
  let title = ''
  let length = 0
  for (const char of normalized) {
    length += Buffer.byteLength(char)
    if (length > bytes) break
    title += char
  }
  return title
}
