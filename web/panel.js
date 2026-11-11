const byId = id => document.getElementById(id)
const nonce = document.querySelector('meta[name=bridge-nonce]').content
const dialog = byId('dialog')
const importButton = byId('import')
const exportButton = byId('export')
const exportDownload = byId('export-download')
const dialogClose = byId('dialog-close')
const dialogText = byId('dialog-text')
const sessionSelect = byId('session-select')
const refreshButton = byId('refresh')
const agentFilter = byId('agent-filter')
const agentPicker = byId('agent-picker')
const agentPopover = byId('agent-popover')
const agentOptions = byId('agent-options')
const themeOptions = [...document.querySelectorAll('[data-theme-choice]')]
const themeKey = 'dsh-agent-bridge.theme'
const projectSearch = byId('project-search')
const assetSearch = byId('asset-search')
const historyOption = byId('history')
const projectList = byId('project-list')
const assetList = byId('asset-list')
const queueList = byId('queue-list')
const projectFilters = [...document.querySelectorAll('[data-project-state]')]
const libraryTabs = ['memory', 'skill'].map(kind => byId(`tab-${kind}`))
const compactLayout = matchMedia('(max-width: 700px)')
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const parentOrigin = window.origin === 'null' ? '*' : window.origin
const agentNames = {
  codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', qoder: 'Qoder',
  workbuddy: 'WorkBuddy', trae: 'TRAE', gemini: 'Gemini', antigravity: 'Antigravity',
  copilot: 'Copilot', qwen: 'Qwen Code', dsh: 'DSH', workspacehub: '项目总账',
  local: '手动目录', manual: '手动目录', export: '记忆导出', shared: '共享',
}
const agentInitials = { claude: 'CC', codex: 'CX', workbuddy: 'WB', trae: 'TR', antigravity: 'AG' }
const sourceStates = { ready: '可读取', partial: '部分可读', unavailable: '未找到', error: '读取失败' }
const scopeNames = { project: '项目', agent: 'Agent 全局', shared: '共享' }
let catalog = []
let agentIcons = {}
let availableAgents = ['']
let selectedAgent = ''
let activeAgentIndex = 0
let agentQuery = ''
let agentQueryAt = 0
let current
let detail
let detailRevision = 0
let detailLoading = false
let tab = 'memory'
let projectState = 'all'
let selected = new Set()
let includeHistory = false
let sourceRevision = null
let refreshing = false
let polling = false
let pollTimer
let ticket
let pending
let dialogMode
let dialogEpoch = 0
let dialogBusy = false
let nativeSessions = []
let downloadUrl
let requestNumber = 0

const clockFormat = new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium', hourCycle: 'h23' })

const agentName = value => Object.hasOwn(agentNames, value) ? agentNames[value] : String(value ?? '')
const text = (tag, content, className) => {
  const element = document.createElement(tag)
  element.textContent = content
  if (className) element.className = className
  return element
}

function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', className ? `icon ${className}` : 'icon')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(svg.namespaceURI, 'use')
  use.setAttribute('href', `#icon-${name}`)
  svg.append(use)
  return svg
}

function agentMark(agent, label = agentName(agent)) {
  const mark = text('span', '', 'agent-brand-mark')
  mark.dataset.agent = agent
  mark.setAttribute('aria-hidden', 'true')
  const initial = () => {
    mark.classList.remove('has-image')
    mark.textContent = Object.hasOwn(agentInitials, agent) ? agentInitials[agent] : (Array.from(label)[0]?.toUpperCase() || '?')
  }
  const file = Object.hasOwn(agentIcons, agent) ? agentIcons[agent] : ''
  if (!/^agent-icons\/[a-z][a-z0-9-]*\.(?:svg|png)$/.test(file)) {
    initial()
    return mark
  }
  const image = document.createElement('img')
  image.alt = ''
  image.decoding = 'async'
  image.addEventListener('error', initial, { once: true })
  image.src = `./${file}`
  mark.classList.add('has-image')
  mark.append(image)
  return mark
}

function agentLabel(agent, className = '', label = agentName(agent)) {
  const span = text('span', '', ['agent-label', className].filter(Boolean).join(' '))
  span.append(agentMark(agent, label), text('span', label, 'agent-label-name'))
  return span
}

function setTheme(value, remember = true) {
  const theme = ['blue', 'white', 'black'].includes(value) ? value : 'blue'
  document.documentElement.dataset.theme = theme
  for (const button of themeOptions) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme))
  }
  if (remember) {
    try { localStorage.setItem(themeKey, theme) } catch { /* Theme is still applied to this panel. */ }
  }
}

function renderAgentPicker(activeAgent = selectedAgent) {
  const label = selectedAgent ? agentName(selectedAgent) : '全部 Agent'
  byId('agent-trigger-mark').replaceChildren(selectedAgent ? agentMark(selectedAgent) : icon('filter'))
  byId('agent-trigger-label').textContent = label
  agentFilter.setAttribute('aria-label', `筛选 Agent，当前为${label}`)
  agentOptions.replaceChildren(...availableAgents.map((agent, index) => {
    const option = text('div', '', 'agent-option')
    option.id = `agent-option-${index}`
    option.dataset.agent = agent
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(agent === selectedAgent))
    option.append(agent ? agentMark(agent) : icon('layers', 'agent-option-mark'),
      text('span', agent ? agentName(agent) : '全部 Agent', 'agent-option-label'), icon('check', 'agent-option-check'))
    return option
  }))
  if (!agentPopover.hidden) {
    positionAgentPicker()
    activateAgentOption(availableAgents.indexOf(availableAgents.includes(activeAgent) ? activeAgent : selectedAgent))
  }
}

function positionAgentPicker() {
  if (agentPopover.hidden) return
  const bounds = agentFilter.getBoundingClientRect()
  const below = window.innerHeight - bounds.bottom
  const above = bounds.top
  agentPopover.dataset.placement = below < agentPopover.getBoundingClientRect().height + 6 && above > below ? 'above' : 'below'
}

function activateAgentOption(index, scroll = true) {
  const previous = agentOptions.children[activeAgentIndex]
  if (previous) delete previous.dataset.active
  activeAgentIndex = Math.max(0, Math.min(index, availableAgents.length - 1))
  const active = agentOptions.children[activeAgentIndex]
  if (!active) return
  active.dataset.active = 'true'
  agentOptions.setAttribute('aria-activedescendant', active.id)
  if (!scroll) return
  const optionBounds = active.getBoundingClientRect()
  const listBounds = agentOptions.getBoundingClientRect()
  if (optionBounds.bottom > listBounds.bottom) agentOptions.scrollTop += optionBounds.bottom - listBounds.bottom
  if (optionBounds.top < listBounds.top) agentOptions.scrollTop -= listBounds.top - optionBounds.top
}

function openAgentPicker() {
  if (!agentPopover.hidden) return
  agentPopover.hidden = false
  agentFilter.setAttribute('aria-expanded', 'true')
  agentQuery = ''
  positionAgentPicker()
  activateAgentOption(availableAgents.indexOf(selectedAgent))
  agentOptions.focus({ preventScroll: true })
  clearTimeout(pollTimer)
}

function closeAgentPicker(restoreFocus = false) {
  if (agentPopover.hidden) return
  agentPopover.hidden = true
  agentOptions.removeAttribute('aria-activedescendant')
  agentFilter.setAttribute('aria-expanded', 'false')
  if (restoreFocus) agentFilter.focus({ preventScroll: true })
  schedulePoll(0)
}

function chooseAgent(index) {
  selectedAgent = availableAgents[index] ?? ''
  closeAgentPicker(true)
  renderAgentPicker()
  projectList.scrollTop = 0
  renderProjects()
}

function navigateAgents(event) {
  const { key } = event
  if (key === 'Escape' || key === 'Tab') {
    if (key === 'Escape') event.preventDefault()
    closeAgentPicker(true)
    return
  }
  if (key === 'Enter' || key === ' ') {
    event.preventDefault()
    chooseAgent(activeAgentIndex)
    return
  }
  const destinations = { ArrowDown: activeAgentIndex + 1, ArrowUp: activeAgentIndex - 1,
    Home: 0, End: availableAgents.length - 1 }
  if (Object.hasOwn(destinations, key)) {
    event.preventDefault()
    activateAgentOption(destinations[key])
    return
  }
  if (key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
  const now = Date.now()
  agentQuery = (now - agentQueryAt < 650 ? agentQuery : '') + key.toLowerCase()
  agentQueryAt = now
  const match = availableAgents.findIndex(agent => agentName(agent).toLowerCase().startsWith(agentQuery))
  if (match > 0) {
    event.preventDefault()
    activateAgentOption(match)
  }
}

function shortPath(value) {
  const separator = value.includes('\\') ? '\\' : '/'
  const parts = value.split(/[\\/]+/).filter(Boolean)
  return parts.length <= 3 ? value : `…${separator}${parts.slice(-2).join(separator)}`
}

function syncSearch(input) {
  const clear = input.parentElement.querySelector('.clear-search')
  const hint = input.parentElement.querySelector('.key-hint')
  clear.hidden = !input.value
  if (hint) hint.hidden = Boolean(input.value)
}

async function api(action, values = {}) {
  const response = await fetch('./api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DSH-Agent-Bridge': nonce },
    body: JSON.stringify({ action, ...values }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new Error(data?.error || '无法连接 DSH 插件。')
  return data
}

function status(message, error = false, target = 'status') {
  const element = byId(target)
  element.textContent = message
  element.classList.toggle('error', error)
}

function renderSources(sources) {
  byId('sources-heading').textContent = `本机来源 · ${sources.length}`
  byId('sources-list').replaceChildren(...sources.map(source => {
    const row = document.createElement('div')
    row.className = 'source-row'
    const state = text('span', sourceStates[source.status] ?? source.status, 'chip source-state')
    state.dataset.state = source.status
    const name = text('strong', '', 'source-name')
    name.append(agentLabel(source.id, '', source.label))
    row.append(name, state)
    if (source.detail) row.append(text('span', source.detail, 'source-detail'))
    return row
  }))
}

function projectMatches() {
  const query = projectSearch.value.trim().toLowerCase()
  return catalog.filter(project => (!selectedAgent || project.agents.includes(selectedAgent))
    && [project.name, project.cwd, ...project.projectIds, ...project.agents.map(agentName)]
      .some(value => value.toLowerCase().includes(query)))
}

function filteredProjects(matches = projectMatches()) {
  if (projectState === 'all') return matches
  return matches.filter(project => project.online === (projectState === 'online'))
}

function renderProjects() {
  syncSearch(projectSearch)
  const base = projectMatches()
  const matches = filteredProjects(base)
  const online = base.filter(project => project.online).length
  const counts = { all: base.length, online, offline: base.length - online }
  const labels = { all: '全部', online: '可接续', offline: '离线' }
  for (const button of projectFilters) {
    const state = button.dataset.projectState
    button.setAttribute('aria-pressed', String(projectState === state))
    button.replaceChildren(document.createTextNode(labels[state]), text('span', counts[state], 'filter-count'))
  }
  byId('project-count').textContent = matches.length === catalog.length ? `${catalog.length} 项` : `${matches.length} / ${catalog.length}`
  const items = matches.map(project => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'project'
    button.id = `project-${project.id}`
    button.setAttribute('aria-pressed', String(current?.id === project.id))
    button.title = project.cwd
    const mark = text('span', '', 'project-icon')
    mark.dataset.agent = project.agents[0] || 'local'
    mark.append(icon('folder'))
    const main = text('span', '', 'project-main')
    main.append(text('span', project.name, 'project-title'), text('span', shortPath(project.cwd), 'project-path'))
    const source = text('span', '', 'project-source')
    for (const agent of project.agents.slice(0, 2)) source.append(agentLabel(agent))
    if (project.agents.length > 2) {
      const rest = text('span', `+${project.agents.length - 2}`, 'project-more-agents')
      rest.title = project.agents.slice(2).map(agentName).join('、')
      source.append(rest)
    }
    if (!project.agents.length) source.textContent = '本地项目'
    const indicator = text('span', '', 'project-state')
    indicator.dataset.state = project.online ? 'online' : 'offline'
    indicator.setAttribute('aria-label', project.online ? '原目录可用' : '原目录不可访问')
    main.append(source)
    button.append(mark, main, indicator)
    button.addEventListener('click', () => selectProject(project, true))
    return button
  })
  const focused = projectList.contains(document.activeElement) ? document.activeElement.id : ''
  const scroll = projectList.scrollTop
  projectList.replaceChildren(...(items.length ? items : [text('p', '没有匹配的项目。', 'asset-empty')]))
  projectList.scrollTop = scroll
  if (focused) byId(focused)?.focus({ preventScroll: true })
}

function renderSelection() {
  byId('selection-count').textContent = `${selected.size} 项`
  byId('compact-selection').textContent = `${selected.size} 项资料${historyOption.checked ? ' · 含会话' : ''}`
  byId('preview').disabled = !detail
  if (!detail) return
  const focused = queueList.contains(document.activeElement) ? document.activeElement.id : ''
  const scroll = queueList.scrollTop
  const entries = [
    ...detail.memories.map(item => [item, 'memory', '记忆']),
    ...detail.skills.map(item => [item, 'skill', 'Skill']),
  ].filter(([item]) => selected.has(item.id))
  byId('handoff').dataset.empty = String(entries.length === 0)
  queueList.replaceChildren(...(entries.length ? entries.map(([item, kind, type]) => {
    const row = text('div', '', 'queue-item')
    const name = text('span', item.name, 'queue-title')
    name.title = item.name
    const kindLabel = text('span', type, 'queue-kind')
    const remove = text('button', '', 'queue-remove icon-button')
    remove.type = 'button'
    remove.id = `queue-remove-${item.id}`
    remove.setAttribute('aria-label', `移除 ${item.name}`)
    remove.append(icon('close'))
    remove.addEventListener('click', () => {
      const next = row.nextElementSibling ?? row.previousElementSibling
      const focusId = next?.querySelector('.queue-remove')?.id
      selected.delete(item.id)
      renderAssets()
      const focusTarget = byId(focusId) ?? byId('preview')
      focusTarget.focus({ preventScroll: true })
    })
    row.append(icon(kind, 'queue-icon'), name, kindLabel, remove)
    return row
  }) : [text('p', '勾选资料后会列在这里。', 'queue-empty')]))
  queueList.scrollTop = scroll
  if (focused) byId(focused)?.focus({ preventScroll: true })
}

function renderAssets() {
  if (!detail) return
  const isMemory = tab === 'memory'
  const query = assetSearch.value.trim().toLowerCase()
  syncSearch(assetSearch)
  const assets = (isMemory ? detail.memories : detail.skills)
    .filter(asset => [asset.name, asset.agent, asset.file].some(value => value.toLowerCase().includes(query)))
  libraryTabs.forEach((button, index) => {
    const active = isMemory === (index === 0)
    button.setAttribute('aria-selected', String(active))
    button.tabIndex = active ? 0 : -1
  })
  byId('library-panel').setAttribute('aria-labelledby', `tab-${tab}`)
  const note = byId('asset-note')
  const used = detail.usedSkills
  note.textContent = isMemory || !used.length ? ''
    : `会话中记录的 Skills · ${used.slice(0, 4).join('、')}${used.length > 4 ? ` +${used.length - 4}` : ''}`
  note.title = isMemory ? '' : used.join('、')
  const rows = assets.map(asset => {
    const row = document.createElement('div')
    row.className = 'asset-row'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.className = 'asset-check'
    checkbox.id = `asset-${asset.id}`
    checkbox.checked = selected.has(asset.id)
    row.dataset.selected = String(checkbox.checked)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked && selected.size >= 24) {
        checkbox.checked = false
        status('每次交接最多选择 24 项资料。', true)
        return
      }
      if (checkbox.checked) selected.add(asset.id)
      else selected.delete(asset.id)
      row.dataset.selected = String(checkbox.checked)
      status('')
      renderSelection()
    })
    const label = text('label', '', 'asset-label')
    label.htmlFor = checkbox.id
    label.title = asset.file
    const title = text('span', asset.name, 'asset-title')
    const meta = text('span', '', 'asset-meta')
    if (asset.agent) meta.append(agentLabel(asset.agent))
    if (asset.scope) meta.append(text('span', scopeNames[asset.scope] ?? asset.scope, 'asset-scope'))
    if (asset.used) meta.append(text('span', '会话提及', 'chip used-skill'))
    label.append(title, meta)
    const button = text('button', '', 'asset-view')
    button.append(document.createTextNode('查看'), icon('chevron'))
    button.type = 'button'
    button.id = `asset-view-${asset.id}`
    button.setAttribute('aria-label', `查看 ${asset.name}`)
    button.addEventListener('click', () => viewAsset(asset))
    const marker = text('span', '', 'asset-icon')
    marker.dataset.kind = tab
    marker.append(icon(tab))
    row.append(checkbox, marker, label, button)
    return row
  })
  const scroll = assetList.scrollTop
  const focused = assetList.contains(document.activeElement) ? document.activeElement.id : ''
  assetList.replaceChildren(...(rows.length ? rows : [
    text('p', query ? '没有匹配的资料。' : (isMemory ? '这个项目暂无可读记忆。' : '这个项目暂无可读 Skills。'), 'asset-empty'),
  ]))
  assetList.scrollTop = scroll
  if (focused) byId(focused)?.focus({ preventScroll: true })
  renderSelection()
}

function applyDetail(project, loaded, preserve) {
  current = loaded.project ?? project
  detail = loaded
  if (preserve) {
    const available = new Set([...detail.memories, ...detail.skills].map(item => item.id))
    selected = new Set([...selected].filter(id => available.has(id)))
  } else {
    const pinned = detail.memories.filter(item => item.agent !== 'export'
      && /(?:当前状态|最新交接|current[- _]state|latest[- _]handoff)/i.test(item.name)).slice(0, 3)
    const observed = detail.skills.filter(item => item.used && item.scope === 'project').slice(0, 3)
    selected = new Set([...pinned, ...observed].map(item => item.id))
    includeHistory = detail.historyCount > 0
  }
  historyOption.checked = includeHistory && detail.historyCount > 0
  historyOption.disabled = detail.historyCount === 0
  byId('history-option').hidden = detail.historyCount === 0
  byId('history-label').textContent = `近期会话 · ${Math.min(8, detail.historyCount)} 条`
  byId('project-name').textContent = current.name
  byId('project-path').textContent = current.cwd
  byId('project-path').title = current.cwd
  const availability = text('span', current.online ? '原目录可用' : '原目录不可访问', 'chip availability')
  availability.dataset.state = current.online ? 'online' : 'offline'
  byId('project-meta').replaceChildren(...current.projectIds.map(value => text('span', value, 'chip')),
    ...current.agents.map(agent => agentLabel(agent, 'chip')), availability)
  libraryTabs[0].querySelector('.tab-count').textContent = detail.memories.length
  libraryTabs[1].querySelector('.tab-count').textContent = detail.skills.length
  byId('empty').hidden = true
  byId('project-detail').hidden = false
  byId('handoff').hidden = false
  renderAssets()
}

async function selectProject(project, reveal = false) {
  const revision = ++detailRevision
  current = project
  detail = undefined
  detailLoading = true
  selected = new Set()
  tab = 'memory'
  assetSearch.value = ''
  byId('empty').textContent = '正在读取项目资料…'
  byId('empty').hidden = false
  byId('project-detail').hidden = true
  byId('handoff').hidden = true
  renderProjects()
  try {
    const loaded = await api('detail', { projectId: project.id })
    if (revision !== detailRevision) return
    byId('asset-list').scrollTop = 0
    applyDetail(project, loaded, false)
    if (reveal && compactLayout.matches) {
      const heading = byId('project-name')
      heading.focus({ preventScroll: true })
      heading.closest('.detail').scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'instant' : 'smooth' })
    }
  } catch (error) {
    if (revision === detailRevision) byId('empty').textContent = error.message
  } finally {
    if (revision === detailRevision) detailLoading = false
  }
}

function canAutoRefresh() {
  return document.visibilityState === 'visible' && !dialog.open && agentPopover.hidden && !detailLoading
}

function liveState(label, scannedAt, error) {
  const indicator = byId('live-state')
  indicator.textContent = label
  indicator.dataset.state = error ? 'error' : label.includes('暂停') ? 'paused' : scannedAt ? 'active' : 'loading'
  indicator.title = error ?? ''
  if (scannedAt) {
    const timestamp = new Date(scannedAt)
    if (Number.isNaN(timestamp.getTime())) return
    const lastScan = byId('last-scan')
    lastScan.dateTime = timestamp.toISOString()
    lastScan.textContent = `上次扫描 ${clockFormat.format(timestamp)}`
    lastScan.hidden = false
  }
}

async function refresh(force, automatic = false) {
  if (refreshing || (automatic && !canAutoRefresh())) return false
  refreshing = true
  refreshButton.disabled = true
  refreshButton.dataset.loading = 'true'
  if (!automatic) status(force ? '正在重新扫描本机来源…' : '正在扫描本机来源…')
  try {
    const result = await api('catalog', { refresh: force })
    if (automatic && !canAutoRefresh()) return false
    const previous = result.projects.find(project => project.id === current?.id)
    const revision = detailRevision
    const loaded = previous && detail ? await api('detail', { projectId: previous.id }) : undefined
    if (automatic && !canAutoRefresh()) return false
    catalog = result.projects
    agentIcons = result.agentIcons ?? {}
    const activeAgent = availableAgents[activeAgentIndex]
    availableAgents = ['', ...[...new Set(catalog.flatMap(project => project.agents))]
      .filter(Boolean).sort((left, right) => agentName(left).localeCompare(agentName(right), 'zh-CN'))]
    if (!availableAgents.includes(selectedAgent)) selectedAgent = ''
    renderAgentPicker(activeAgent)
    renderSources(result.sources)
    if (!automatic) status('')
    if (revision === detailRevision) {
      const next = previous ?? filteredProjects()[0]
      if (loaded) applyDetail(previous, loaded, true)
      else if (next) void selectProject(next)
      else {
        current = undefined
        detail = undefined
        detailLoading = false
        ++detailRevision
        byId('empty').textContent = '未找到可浏览的项目。请展开本机来源查看读取状态。'
        byId('empty').hidden = false
        byId('project-detail').hidden = true
        byId('handoff').hidden = true
      }
    }
    renderProjects()
    sourceRevision = result.revision ?? sourceRevision
    liveState('实时扫描已开启', result.scannedAt)
    return true
  } catch (error) {
    liveState('实时扫描暂不可用', undefined, error.message)
    if (!automatic) {
      status(error.message, true)
      byId('empty').textContent = '项目列表暂不可用。'
    }
    return false
  } finally {
    refreshing = false
    refreshButton.disabled = false
    delete refreshButton.dataset.loading
  }
}

function schedulePoll(delay = 250) {
  clearTimeout(pollTimer)
  if (document.visibilityState === 'visible' && !dialog.open && agentPopover.hidden) pollTimer = setTimeout(pollSources, delay)
}

async function pollSources() {
  if (polling) return
  if (refreshing || !canAutoRefresh()) {
    schedulePoll()
    return
  }
  polling = true
  const baseline = sourceRevision
  let delay = 250
  try {
    const result = await api('changes', { revision: baseline, projectId: current?.id, wait: true })
    if (sourceRevision !== baseline || refreshing || !canAutoRefresh()) return
    if (result.changed) {
      if (!await refresh(false, true)) delay = 1000
      else if (sourceRevision === baseline) sourceRevision = result.revision ?? sourceRevision
      return
    }
    sourceRevision = result.revision ?? sourceRevision
    liveState('实时扫描已开启', result.scannedAt)
  } catch (error) {
    if (canAutoRefresh()) liveState('实时扫描暂不可用', undefined, error.message)
    delay = 5000
  } finally {
    polling = false
    schedulePoll(delay)
  }
}

function clearDownload() {
  if (downloadUrl) {
    const previousUrl = downloadUrl
    setTimeout(() => URL.revokeObjectURL(previousUrl), 30_000)
  }
  downloadUrl = undefined
  exportDownload.removeAttribute('href')
  exportDownload.hidden = true
  byId('export-output').hidden = true
  byId('export-output').open = false
  byId('export-text').textContent = ''
}

function setDialogBusy(busy) {
  dialogBusy = busy
  dialogClose.disabled = busy
  importButton.disabled = busy
  exportButton.disabled = busy
  sessionSelect.disabled = busy
}

function showDialog(mode, title, note, body) {
  dialogMode = mode
  dialog.dataset.mode = mode
  ticket = undefined
  nativeSessions = []
  clearDownload()
  byId('dialog-title').textContent = title
  byId('dialog-note').textContent = note
  byId('dialog-mark').replaceChildren(icon(mode === 'session' ? 'download' : mode === 'asset' ? tab : 'bridge'))
  dialogText.hidden = false
  dialogText.dataset.format = 'plain'
  dialogText.textContent = body
  dialogText.closest('.dialog-content').scrollTop = 0
  byId('session-choice').hidden = true
  status('', false, 'dialog-status')
  importButton.hidden = true
  exportButton.hidden = true
  setDialogBusy(false)
  if (!dialog.open) dialog.showModal()
  clearTimeout(pollTimer)
  liveState('实时扫描已暂停')
  return ++dialogEpoch
}

function renderHandoff({ intro, sections, footer }) {
  const lead = text('div', '', 'preview-intro')
  const [heading, ...introLines] = intro.split('\n')
  lead.append(text('p', heading, 'preview-lead'))
  for (const line of introLines.slice(0, 2)) {
    const metadata = /^(工作目录|来源)：(.+)$/.exec(line)
    if (metadata) {
      const row = text('div', '', 'preview-meta')
      row.append(text('span', metadata[1]), text('code', metadata[2]))
      lead.append(row)
    } else if (line) lead.append(text('p', line, 'preview-context'))
  }
  const context = introLines.slice(2).join('\n').trim()
  if (context) lead.append(text('p', context, 'preview-context'))
  const content = sections.map(section => {
    const block = text('section', '', 'preview-section')
    block.append(text('h3', section.label))
    if (section.file) block.append(text('code', section.file, 'preview-source'))
    block.append(text('p', section.text.trim(), 'preview-body'))
    return block
  })
  dialogText.dataset.format = 'handoff'
  dialogText.replaceChildren(lead, ...content)
  if (footer) dialogText.append(text('p', footer, 'preview-context'))
}

async function viewAsset(asset) {
  const project = current
  const epoch = showDialog('asset', asset.name, asset.file, '正在读取…')
  try {
    const result = await api('asset', { projectId: project.id, assetId: asset.id })
    if (!dialog.open || dialogEpoch !== epoch) return
    dialogText.textContent = result.text + (result.truncated ? '\n\n[预览已截取]' : '')
  } catch (error) {
    if (dialog.open && dialogEpoch === epoch) status(error.message, true, 'dialog-status')
  }
}

async function preview() {
  const project = current
  if (!project) return
  const note = project.online
    ? '可导出 Markdown，或在原工作目录打开 DSH 会话并继续编辑草稿。'
    : '原工作目录不可访问。可将现有交接资料导出为 Markdown。'
  const epoch = showDialog('handoff', '交接预览', note, '正在准备…')
  try {
    const result = await api('preview', { projectId: project.id, assetIds: [...selected], history: historyOption.checked })
    if (!dialog.open || dialogEpoch !== epoch) return
    ticket = result.ticket
    if (result.preview) renderHandoff(result.preview)
    else dialogText.textContent = result.prompt
    importButton.hidden = result.canImport === false || !project.online
    exportButton.hidden = false
    if (result.truncated) status('部分资料已截取。完整内容可在来源文件查看。', false, 'dialog-status')
  } catch (error) {
    if (dialog.open && dialogEpoch === epoch) status(error.message, true, 'dialog-status')
  }
}

function requestParent(type, values, requestId = `bridge-${Date.now()}-${++requestNumber}`) {
  if (window.parent === window) {
    return Promise.reject(new Error('请在 DSH 侧栏打开 Agent 接续后使用此操作。'))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending = undefined
      reject(new Error('DSH 暂未响应。请重试。'))
    }, 25_000)
    pending = { requestId, timer, resolve, reject }
    try {
      window.parent.postMessage({ type: `dsh-agent-bridge:${type}`, requestId, ...values }, parentOrigin)
    } catch (error) {
      clearTimeout(timer)
      pending = undefined
      reject(error)
    }
  })
}

async function importSession() {
  if (!ticket || dialogBusy || importButton.hidden) return
  setDialogBusy(true)
  status('正在创建 DSH 会话…', false, 'dialog-status')
  try {
    const { path, prompt } = await api('open', { ticket })
    await requestParent('open', { path, prompt }, ticket)
    ticket = undefined
    dialog.close()
    status('DSH 会话已打开。交接草稿已填入输入框。')
  } catch (error) {
    status(error.message, true, 'dialog-status')
  } finally {
    setDialogBusy(false)
  }
}

function showDownload({ filename, markdown }) {
  if (typeof filename !== 'string' || typeof markdown !== 'string') throw new Error('未收到可导出的 Markdown。')
  clearDownload()
  byId('export-text').textContent = markdown
  byId('export-output').hidden = false
  try {
    downloadUrl = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
    exportDownload.href = downloadUrl
    exportDownload.download = filename
    exportDownload.hidden = false
    exportDownload.click()
    status(`已生成 ${filename}。`, false, 'dialog-status')
  } catch {
    byId('export-output').open = true
    status(`已生成 ${filename}。可复制下方 Markdown。`, false, 'dialog-status')
  }
}

function selectedNativeSession() {
  return nativeSessions.find(session => session.id === sessionSelect.value)
}

function renderSessionPath() {
  const session = selectedNativeSession()
  byId('session-path').textContent = session?.path ?? ''
}

async function chooseNativeSession() {
  showDialog('session', '导出 DSH 会话', '将会话中的用户与助手消息保存为 Markdown。', '正在读取 DSH 会话…')
  setDialogBusy(true)
  try {
    const result = await requestParent('sessions', {})
    nativeSessions = result.sessions
    if (!nativeSessions.length) {
      dialogText.textContent = '暂无可导出的 DSH 会话。'
      return
    }
    const titles = new Map()
    for (const { title } of nativeSessions) titles.set(title, (titles.get(title) ?? 0) + 1)
    sessionSelect.replaceChildren(...nativeSessions.map(session => {
      const title = session.title || '未命名会话'
      const suffix = titles.get(session.title) > 1 && session.path ? ` · ${shortPath(session.path)}` : ''
      return new Option(title + suffix, session.id)
    }))
    renderSessionPath()
    dialogText.hidden = true
    byId('session-choice').hidden = false
    exportButton.hidden = false
  } catch (error) {
    dialogText.hidden = true
    status(error.message, true, 'dialog-status')
  } finally {
    setDialogBusy(false)
  }
}

async function exportMarkdown() {
  if (dialogBusy || exportButton.hidden) return
  setDialogBusy(true)
  status('正在生成 Markdown…', false, 'dialog-status')
  try {
    if (dialogMode === 'session') {
      const session = selectedNativeSession()
      if (!session) throw new Error('请选择要导出的 DSH 会话。')
      const result = await requestParent('session-export', { sessionId: session.id, path: session.path })
      showDownload(await api('export-session', { conversation: result.conversation }))
    } else if (ticket) {
      showDownload(await api('export', { ticket }))
    }
  } catch (error) {
    status(error.message, true, 'dialog-status')
  } finally {
    setDialogBusy(false)
  }
}

async function copyProjectPath() {
  if (!current) return
  const button = byId('copy-path')
  try {
    await navigator.clipboard.writeText(current.cwd)
    button.dataset.state = 'copied'
    button.replaceChildren(icon('check'))
    button.setAttribute('aria-label', '已复制工作目录')
    setTimeout(() => {
      delete button.dataset.state
      button.replaceChildren(icon('copy'))
      button.setAttribute('aria-label', '复制工作目录')
    }, 1600)
  } catch {
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(byId('project-path'))
    selection.removeAllRanges()
    selection.addRange(range)
    status('已选中工作目录，按 Ctrl+C 或 ⌘C 复制。')
  }
}

function switchTab(index, focus = false) {
  tab = index === 0 ? 'memory' : 'skill'
  assetSearch.value = ''
  assetList.scrollTop = 0
  renderAssets()
  if (focus) libraryTabs[index].focus()
}

function wireClear(input, action) {
  input.parentElement.querySelector('.clear-search').addEventListener('click', () => {
    input.value = ''
    action()
    input.focus()
  })
}

window.addEventListener('message', event => {
  if (event.source !== window.parent || (parentOrigin !== '*' && event.origin !== parentOrigin)) return
  const data = event.data
  if (!pending || data?.type !== 'dsh-agent-bridge:result' || pending.requestId !== data.requestId) return
  const request = pending
  pending = undefined
  clearTimeout(request.timer)
  if (data.ok) request.resolve(data)
  else request.reject(new Error(data.error || 'DSH 暂无法完成此操作。'))
})
refreshButton.addEventListener('click', () => refresh(true))
projectSearch.addEventListener('input', renderProjects)
agentFilter.addEventListener('click', () => {
  if (agentPopover.hidden) openAgentPicker()
  else closeAgentPicker(true)
})
agentFilter.addEventListener('keydown', event => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  openAgentPicker()
})
agentOptions.addEventListener('keydown', navigateAgents)
agentOptions.addEventListener('pointermove', event => {
  const option = event.target.closest('.agent-option')
  if (option) activateAgentOption(availableAgents.indexOf(option.dataset.agent), false)
})
agentOptions.addEventListener('click', event => {
  const option = event.target.closest('.agent-option')
  if (option) chooseAgent(availableAgents.indexOf(option.dataset.agent))
})
document.addEventListener('pointerdown', event => {
  if (!agentPicker.contains(event.target)) closeAgentPicker()
})
document.addEventListener('focusin', event => {
  if (!agentPicker.contains(event.target)) closeAgentPicker()
})
window.addEventListener('resize', positionAgentPicker)
window.addEventListener('scroll', positionAgentPicker, { passive: true })
assetSearch.addEventListener('input', renderAssets)
wireClear(projectSearch, renderProjects)
wireClear(assetSearch, renderAssets)
for (const button of projectFilters) {
  button.addEventListener('click', () => {
    projectState = button.dataset.projectState
    projectList.scrollTop = 0
    renderProjects()
  })
}
document.addEventListener('keydown', event => {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || dialog.open || !agentPopover.hidden
    || event.target.matches?.('input, select, textarea, [contenteditable]')) return
  event.preventDefault()
  projectSearch.focus()
})
projectList.addEventListener('keydown', event => {
  const buttons = [...projectList.querySelectorAll('.project')]
  const currentIndex = buttons.indexOf(event.target)
  if (currentIndex < 0) return
  let nextIndex
  if (event.key === 'ArrowDown') nextIndex = Math.min(buttons.length - 1, currentIndex + 1)
  if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1)
  if (event.key === 'Home') nextIndex = 0
  if (event.key === 'End') nextIndex = buttons.length - 1
  if (nextIndex === undefined) return
  event.preventDefault()
  buttons[nextIndex].focus()
})
historyOption.addEventListener('change', () => {
  includeHistory = historyOption.checked
  renderSelection()
})
libraryTabs.forEach((button, index) => {
  button.addEventListener('click', () => switchTab(index))
  button.addEventListener('keydown', event => {
    let next
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = libraryTabs.length - 1
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = (index + 1) % libraryTabs.length
    if (next === undefined) return
    event.preventDefault()
    switchTab(next, true)
  })
})
byId('copy-path').addEventListener('click', copyProjectPath)
byId('preview').addEventListener('click', preview)
byId('native-export').addEventListener('click', chooseNativeSession)
sessionSelect.addEventListener('change', clearDownload)
sessionSelect.addEventListener('change', renderSessionPath)
dialogClose.addEventListener('click', () => dialog.close())
dialog.addEventListener('click', event => {
  if (event.target !== dialog || dialogBusy) return
  const bounds = dialog.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close()
})
dialog.addEventListener('cancel', event => { if (dialogBusy) event.preventDefault() })
dialog.addEventListener('close', () => {
  ++dialogEpoch
  clearDownload()
  liveState('正在恢复实时扫描')
  schedulePoll(0)
})
importButton.addEventListener('click', importSession)
exportButton.addEventListener('click', exportMarkdown)
document.addEventListener('visibilitychange', () => schedulePoll(0))
for (const button of themeOptions) button.addEventListener('click', () => setTheme(button.dataset.themeChoice))
let savedTheme
try { savedTheme = localStorage.getItem(themeKey) } catch { /* Use the default theme. */ }
setTheme(savedTheme, false)
renderAgentPicker()
void refresh(false).finally(() => schedulePoll(0))
