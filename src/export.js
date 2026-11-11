export function makeExport({ title, prompt, origin, date = new Date(), truncated = false }) {
  const heading = title.replace(/[\r\n\u0000-\u001f]+/g, ' ').trim() || '项目交接'
  const name = heading.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+|[.-]+$/g, '')
  const stamp = date.toISOString()
  const suffix = stamp.slice(0, 19).replace(/[-:]/g, '') + 'Z'
  const metadata = [`来源：${origin}`, `导出时间：${stamp}`]
  if (truncated) metadata.push('部分内容已截取。')
  return {
    filename: `handoff-${Array.from(name).slice(0, 48).join('') || 'project'}-${suffix}.md`,
    markdown: [`# ${heading}`, '', metadata.join('  \n'), '', prompt.trimEnd(), ''].join('\n'),
  }
}
