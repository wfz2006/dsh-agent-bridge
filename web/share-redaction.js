export const shareReplacements = {
  path: '〈本机路径已脱敏〉',
  email: '〈邮箱已脱敏〉',
  ip: '〈IP 已脱敏〉',
  credential: '〈凭据已脱敏〉',
}

const pathStarts = /(?<![A-Za-z0-9_./\\-])(?:file:\/{1,3}|[a-z]:[\\/]+|\\{2,}[?.][\\/]+(?:[a-z]:[\\/]+|UNC[\\/]+[\p{L}\p{N}._-]+[\\/]+)|\\{2,}[\p{L}\p{N}._-]+[\\/]+|%(?:USERPROFILE|HOMEPATH|LOCALAPPDATA|APPDATA|TEMP|TMP)%[\\/]+|(?:~|\$HOME|\$\{HOME\})[\\/]+|\/[\p{L}\p{N}._-]+\/|\/(?:home|Users|Volumes|tmp|var|etc|mnt|opt|root|private|workspace|workspaces)(?=$|[\s"'`<>\])、。]))/giu
const pathWord = /[^\s"'`<>\[\]{}|;,!?，。；、！？]+/uy
const filenameEnd = /\.(?:md|txt|jsonl?|log|ya?ml|toml|ini|conf|env|xml|pdf|csv|png|jpe?g|webp|svg|zip|gz|html?|py|[cm]?js|tsx?|css|cpp?|h|exe|dll|sh|ps1|sql|db|sqlite)[.)*]*$/iu
const quotedPathTail = {
  '<': /[^<>\r\n]*(?=>)/y,
  '"': /[^"\r\n]*(?=")/y,
  "'": /[^'\r\n]*(?=')/y,
  '`': /[^`\r\n]*(?=`)/y,
  '“': /[^“”\r\n]*(?=”)/y,
  '‘': /[^‘’\r\n]*(?=’)/y,
  '「': /[^「」\r\n]*(?=」)/y,
  '《': /[^《》\r\n]*(?=》)/y,
}

function pathEnd(text, start, prefixEnd) {
  const quoted = quotedPathTail[text[start - 1]]
  if (quoted) {
    quoted.lastIndex = prefixEnd
    if (quoted.exec(text)) return quoted.lastIndex
  }
  pathWord.lastIndex = prefixEnd
  let end = pathWord.exec(text) ? pathWord.lastIndex : prefixEnd
  let next = end
  // A separated word can continue an unquoted path through a directory with
  // spaces. Require another separator or a recognized filename suffix.
  for (let words = 0; words < 8 && text[next] === ' ' && !filenameEnd.test(text.slice(prefixEnd, end)); words++) {
    while (text[next] === ' ') next++
    pathWord.lastIndex = next
    const word = pathWord.exec(text)?.[0]
    if (!word || /[@:=]|^\.\.?[\\/]|^[\\/]/u.test(word)) break
    next = pathWord.lastIndex
    if (/[\\/]/u.test(word) || filenameEnd.test(word)) end = next
  }
  let value = text.slice(start, end).replace(/[.*]+$/u, '')
  let excess = (value.match(/\)/g)?.length ?? 0) - (value.match(/\(/g)?.length ?? 0)
  while (excess > 0 && value.endsWith(')')) {
    value = value.slice(0, -1)
    excess--
  }
  return start + value.length
}

const emails = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}][\p{L}\p{N}._%+-]{0,63}(?:@|%40|&#0*64;|&#x0*40;)(?:[\p{L}\p{N}][\p{L}\p{N}-]{0,62}\.)+[\p{L}]{2,63}(?![\p{L}\p{N}_-])/giu
const ipv4 = /(?<![\p{L}\p{N}_.-])(?:\d{1,3}\.){3}\d{1,3}(?![\p{L}\p{N}_-]|\.\d)/gu
const ipv6 = /\[[\da-f:.]+(?:%[\w.-]+)?\]|(?<![\p{L}\p{N}_:])(?:[\da-f]{0,4}:){2,8}[\da-f:.]+(?:%[\w.-]+)?(?![\p{L}\p{N}_:])/giu

function validIpv4(value) {
  return value.split('.').every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function validIpv6(value) {
  let address = value.replace(/^\[|\]$/g, '').split('%', 1)[0]
  if (address.includes('.')) {
    const separator = address.lastIndexOf(':')
    const tail = address.slice(separator + 1)
    if (tail.split('.').length !== 4 || !validIpv4(tail)) return false
    address = address.slice(0, separator + 1) + '0:0'
  }
  const compressed = address.split('::')
  if (compressed.length > 2) return false
  const parts = compressed.filter(Boolean).flatMap(part => part.split(':'))
  return parts.every(part => /^[\da-f]{1,4}$/i.test(part))
    && (compressed.length === 2 ? parts.length < 8 : parts.length === 8)
}

const knownSecrets = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|\b(?:sk-[\w-]{12,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[\w-]{10,}|eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,})\b/gu
const authValues = /\b(?:Bearer|Authorization["']?[ \t]*[:=][ \t]*["']?Basic)[ \t]+([\w+/=-]{8,}(?:\.[\w+/=-]+)*)/gidu
const assignedValues = /\b(?:[a-z0-9]+[-_]){0,8}(?:api[-_]?key|secret[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|auth[-_]?token|client[-_]?secret|password|passwd|secret|token|cookie)["']?[ \t]*[:=][ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s<>"'`,;|&()\[\]{}]+))/gidu
const urlCredentials = /:\/\/([^/\s:@<>"'`]+:[^/\s@<>"'`]+)@/gdu
const masked = /^(?:\[已隐藏(?:凭据|私钥)?\]|\[REDACTED\]|〈[^〉]+已脱敏〉|\*+|<redacted>)$/iu

export function findShareFindings(markdown) {
  const candidates = []
  function add(kind, start, end) {
    if (end > start) candidates.push({ kind, start, end })
  }
  for (const match of markdown.matchAll(pathStarts)) {
    add('path', match.index, pathEnd(markdown, match.index, match.index + match[0].length))
  }
  for (const match of markdown.matchAll(emails)) add('email', match.index, match.index + match[0].length)
  for (const [pattern, valid] of [[ipv4, validIpv4], [ipv6, validIpv6]]) {
    for (const match of markdown.matchAll(pattern)) {
      if (valid(match[0])) add('ip', match.index, match.index + match[0].length)
    }
  }
  for (const match of markdown.matchAll(knownSecrets)) add('credential', match.index, match.index + match[0].length)
  for (const pattern of [assignedValues, authValues, urlCredentials]) {
    for (const match of markdown.matchAll(pattern)) {
      const [start, end] = match.indices.slice(1).find(Boolean)
      if (!masked.test(markdown.slice(start, end))) add('credential', start, end)
    }
  }

  const findings = []
  const importance = { credential: 4, path: 3, email: 2, ip: 1 }
  const newlines = markdown.matchAll(/\r\n|\n|\r/g)
  let newline = newlines.next().value
  let line = 1
  for (const candidate of candidates.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = findings.at(-1)
    if (previous && candidate.start < previous.end) {
      previous.end = Math.max(previous.end, candidate.end)
      if (importance[candidate.kind] > importance[previous.kind]) previous.kind = candidate.kind
      continue
    }
    while (newline && newline.index < candidate.start) {
      line++
      newline = newlines.next().value
    }
    findings.push({ ...candidate, line })
  }
  return findings
}

export function redactShareMarkdown(markdown, findings, kept = new Set(), replacements = shareReplacements) {
  let previousEnd = 0
  const parts = []
  for (const { kind, start, end } of findings) {
    if (kept.has(start)) continue
    parts.push(markdown.slice(previousEnd, start), replacements[kind])
    previousEnd = end
  }
  parts.push(markdown.slice(previousEnd))
  return parts.join('')
}
