import { findShareFindings, redactShareMarkdown, shareReplacements } from './share-redaction.js'

const translations = {
  zh: {
    title: '审阅分享版 Markdown',
    instructions: '检测到的内容默认脱敏。可逐项选择保留，并核对最终 Markdown。',
    findings: '敏感项',
    preview: '最终 Markdown 预览',
    loading: '正在读取并检查 Markdown…',
    error: '无法读取要审阅的 Markdown，请关闭后重试。',
    empty: '未检测到敏感项。',
    totals: (count, kept) => count + ' 项 · 已选保留 ' + kept + ' 项',
    line: (kind, number) => kind + ' · 第 ' + number + ' 行',
    page: (page, total) => '第 ' + page + ' / ' + total + ' 页',
    previous: '上一页',
    next: '下一页',
    keep: '保留',
    redact: '脱敏',
    close: '关闭',
    download: '确认并下载',
    downloaded: '已开始下载。',
    kinds: { path: '本机路径', email: '邮箱', ip: 'IP 地址', credential: '凭据' },
    replacements: shareReplacements,
  },
  en: {
    title: 'Review shareable Markdown',
    instructions: 'Matches are redacted by default. Choose what to keep and check the final Markdown.',
    findings: 'Sensitive items',
    preview: 'Final Markdown preview',
    loading: 'Reading and checking Markdown…',
    error: 'Could not read the Markdown. Close the review and try again.',
    empty: 'No sensitive items detected.',
    totals: (count, kept) => count + ' items · ' + kept + ' kept',
    line: (kind, number) => kind + ' · Line ' + number,
    page: (page, total) => 'Page ' + page + ' of ' + total,
    previous: 'Previous',
    next: 'Next',
    keep: 'Keep',
    redact: 'Redact',
    close: 'Close',
    download: 'Confirm and download',
    downloaded: 'Download started.',
    kinds: { path: 'Local path', email: 'Email address', ip: 'IP address', credential: 'Credential' },
    replacements: { path: '[Local path redacted]', email: '[Email redacted]', ip: '[IP redacted]', credential: '[Credential redacted]' },
  },
}

function element(tag, name, value) {
  const node = document.createElement(tag)
  if (name) node.className = name
  if (value) node.textContent = value
  return node
}

function button(label, action, className = 'reader-button') {
  const node = element('button', className, label)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

export async function loadSourceSharePreview(url, signal) {
  const response = await fetch(url, { signal, headers: { Accept: 'text/plain' } })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.error || '')
  }
  return { filename: 'agent-conversation-share.md', markdown: await response.text() }
}

export function openShareReview({ load, theme = 'white', language = 'zh', onClose } = {}) {
  const t = translations[language === 'en' ? 'en' : 'zh']
  const focus = document.activeElement
  const request = new AbortController()
  const dialog = element('dialog', 'bridge-reader bridge-reader-dialog bridge-share-dialog')
  dialog.dataset.theme = theme
  dialog.setAttribute('aria-label', t.title)
  const header = element('header', 'share-header')
  const title = element('div', 'share-identity')
  title.append(element('h2', '', t.title), element('p', '', t.instructions))
  const close = button('×', () => dialog.close(), 'reader-button share-close')
  close.setAttribute('aria-label', t.close)
  header.append(title, close)

  const content = element('div', 'share-content')
  const review = element('section', 'share-pane')
  const reviewHeading = element('header', 'share-pane-heading')
  const count = element('span', 'share-count', t.loading)
  count.setAttribute('role', 'status')
  reviewHeading.append(element('h3', '', t.findings), count)
  const list = element('ul', 'share-findings')
  list.setAttribute('aria-label', t.findings)
  const pager = element('nav', 'share-pager')
  pager.hidden = true
  const pageText = element('span')
  pageText.setAttribute('aria-live', 'polite')
  const previous = button(t.previous, () => showPage(page - 1))
  const next = button(t.next, () => showPage(page + 1))
  pager.append(previous, pageText, next)
  review.append(reviewHeading, list, pager)
  const previewPane = element('section', 'share-pane share-preview-pane')
  const preview = element('pre', 'share-preview')
  preview.tabIndex = 0
  preview.setAttribute('aria-label', t.preview)
  previewPane.append(element('h3', '', t.preview), preview)
  content.append(review, previewPane)

  const footer = element('footer', 'share-footer')
  const feedback = element('span', 'share-feedback')
  feedback.setAttribute('role', 'status')
  const approve = button(t.download, download, 'reader-button share-approve')
  approve.disabled = true
  footer.append(feedback, approve)
  dialog.append(header, content, footer)

  const pageSize = 20
  let page = 0
  let draft
  let finalMarkdown
  let findings = []
  const kept = new Set()

  function updatePreview() {
    finalMarkdown = redactShareMarkdown(draft.markdown, findings, kept, t.replacements)
    preview.textContent = finalMarkdown
    count.textContent = findings.length ? t.totals(findings.length, kept.size) : t.empty
    feedback.textContent = ''
  }

  function findingRow({ start, end, kind, line }) {
    const result = element('li', 'share-finding')
    const label = t.line(t.kinds[kind], line)
    const select = element('select', 'share-choice')
    select.setAttribute('aria-label', label)
    select.append(new Option(t.redact, 'redact'), new Option(t.keep, 'keep'))
    select.value = kept.has(start) ? 'keep' : 'redact'
    select.addEventListener('change', () => {
      if (select.value === 'keep') kept.add(start)
      else kept.delete(start)
      updatePreview()
    })
    const itemHeader = element('div', 'share-finding-heading')
    itemHeader.append(element('strong', '', label), select)
    const context = element('p', 'share-context')
    const before = draft.markdown.slice(Math.max(0, start - 42), start).split(/\r\n|\n|\r/).at(-1)
    const after = draft.markdown.slice(end, end + 55).split(/\r\n|\n|\r/, 1)[0]
    const value = draft.markdown.slice(start, Math.min(end, start + 180))
    const match = element('mark', '', value + (end - start > value.length ? '…' : ''))
    context.append(before, match, after)
    result.append(itemHeader, context)
    return result
  }

  function showPage(index) {
    page = index
    const total = Math.ceil(findings.length / pageSize)
    list.replaceChildren(...findings.slice(page * pageSize, (page + 1) * pageSize).map(findingRow))
    list.scrollTop = 0
    pager.hidden = total <= 1
    pageText.textContent = t.page(page + 1, total)
    previous.disabled = page === 0
    next.disabled = page >= total - 1
  }

  function download() {
    if (!draft || finalMarkdown === undefined) return
    try {
      const url = URL.createObjectURL(new Blob([finalMarkdown], { type: 'text/markdown;charset=utf-8' }))
      const link = element('a')
      link.href = url
      link.download = draft.filename
      dialog.append(link)
      try { link.click() } finally {
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 30_000)
      }
      feedback.textContent = t.downloaded
    } catch {
      feedback.textContent = t.error
    }
  }

  dialog.addEventListener('close', () => {
    request.abort()
    dialog.remove()
    if (focus?.isConnected) focus.focus({ preventScroll: true })
    onClose?.()
  }, { once: true })
  document.body.append(dialog)
  dialog.showModal()

  Promise.resolve().then(() => load(request.signal)).then(value => {
    if (request.signal.aborted) return
    if (typeof value?.markdown !== 'string' || typeof value.filename !== 'string') throw new Error()
    draft = value
    findings = findShareFindings(draft.markdown)
    showPage(0)
    updatePreview()
    approve.disabled = false
  }).catch(error => {
    if (!request.signal.aborted) count.textContent = error.message || t.error
  })
  return () => { if (dialog.open) dialog.close() }
}
