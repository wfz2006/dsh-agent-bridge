import { describeProjectContext } from './project-context.js'

const byId = id => document.getElementById(id)
const nonce = document.querySelector('meta[name=bridge-nonce]').content
const dialog = byId('dialog')
const importButton = byId('import')
const recoverDraftButton = byId('recover-draft')
const exportButton = byId('export')
const exportDownload = byId('export-download')
const dialogClose = byId('dialog-close')
const dialogText = byId('dialog-text')
const sessionSelect = byId('session-select')
const historySearch = byId('history-search')
const historyResults = byId('history-results')
const historyImport = byId('history-import')
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
const projectManage = byId('project-manage')
const selectVisible = byId('project-select-visible')
const bulkArchive = byId('project-bulk-action')
const archiveAction = byId('project-archive-action')
const projectUndo = byId('project-undo')
const projectPin = byId('project-pin')
const draftWorkflow = byId('draft-workflow')
const projectMaterials = byId('project-materials')
const globalLibrary = byId('global-library')
const globalMaterials = byId('global-materials')
const queueList = byId('queue-list')
const recentList = byId('recent-conversations')
const recentStatus = byId('recent-status')
const browseHistory = byId('browse-history')
const projectFilters = [...document.querySelectorAll('[data-project-state]')]
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
const materialGroups = [
  ['progress', '上次做到哪', '交接记录、最新进度和待办。'],
  ['guides', '项目约定', '开发规则、操作指引和偏好。'],
  ['used', '会话中提及的 Skills', '在这个项目的近期对话中有记录。'],
  ['notes', '其他项目笔记', '经验、决策和存档，可按需带入。'],
  ['skills', '其他项目 Skills', '放在项目目录里，按任务选用。'],
]
const globalGroups = [
  ['guides', '通用指引'],
  ['notes', '通用记忆'],
  ['skills', '通用 Skills'],
]
let catalog = []
let catalogLoaded = false
let agentIcons = {}
let availableAgents = ['']
let selectedAgent = ''
let projectQuery = ''
let activeAgentIndex = 0
let agentQuery = ''
let agentQueryAt = 0
let current
let detail
let context
let detailRevision = 0
let detailLoading = false
let projectState = 'all'
let archiveAvailable = false
let nativeSessionImport = false
let preferencesAvailable = false
let managingProjects = false
const selectedProjects = new Set()
const pinRequests = new Set()
const projectSelections = new Map()
const selectionSaves = new Map()
let archiveBusy = false
let undoArchive
let selected = new Set()
let includeHistory = false
let sourceRevision = null
let lastPinRevision = 0
let refreshing = false
let polling = false
let pollTimer
let ticket
let pending
let dialogMode
let dialogEpoch = 0
let dialogBusy = false
let nativeSessions = []
let recentRevision = 0
let recentKey = ''
let historyProject
let historySessions
let historyLimit = 30
let historyChosenId
let historyTicket
let importedSessionId
let draftRecovery
let historyPreview = 0
let downloadUrl
let requestNumber = 0

const clockFormat = new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium', hourCycle: 'h23' })
const historyDateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const recentDateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const shortClock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

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
  updateProjectView()
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

async function api(action, values = {}, { keepalive = false } = {}) {
  const response = await fetch('./api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DSH-Agent-Bridge': nonce },
    body: JSON.stringify({ action, ...values }),
    keepalive,
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
  return catalog.filter(project => (!selectedAgent || project.agents.includes(selectedAgent))
    && [project.name, project.cwd, ...project.projectIds, ...project.agents.map(agentName)]
      .some(value => value.toLowerCase().includes(projectQuery)))
}

function filteredProjects(matches = projectMatches()) {
  if (projectState === 'archived') return matches.filter(project => project.archived)
  return matches.filter(project => !project.archived && (projectState === 'all' || project.online === (projectState === 'online')))
}

function projectGroups(matches) {
  if (!preferencesAvailable || projectState === 'archived') return [['', matches]]
  const pinned = matches.filter(project => project.pinned)
  const recent = matches.filter(project => !project.pinned && project.continuedAt != null)
    .sort((a, b) => b.continuedAt - a.continuedAt).slice(0, 5)
  if (!pinned.length && !recent.length) return [['', matches]]
  const featured = new Set([...pinned, ...recent].map(project => project.id))
  return [['置顶', pinned], ['最近接续', recent], ['其他项目', matches.filter(project => !featured.has(project.id))]]
}

function renderPin() {
  const pinned = Boolean(current?.pinned)
  projectPin.hidden = !preferencesAvailable || !current || current.archived
  projectPin.disabled = !detail || pinRequests.has(current?.id)
  projectPin.setAttribute('aria-pressed', String(pinned))
  byId('project-pin-label').textContent = pinned ? '取消置顶' : '置顶'
  byId('project-pin-icon').setAttribute('href', pinned ? '#icon-unpin' : '#icon-pin')
}

async function toggleProjectPin() {
  if (!preferencesAvailable || !current || current.archived || !detail) return
  const projectId = current.id
  if (pinRequests.has(projectId)) return
  const pinned = !current.pinned
  pinRequests.add(projectId)
  renderPin()
  try {
    const result = await api('set-project-pin', { projectId, pinned })
    lastPinRevision = Math.max(lastPinRevision, result.revision)
    const project = catalog.find(item => item.id === projectId)
    if (project) project.pinned = pinned
    if (current?.id === projectId) current.pinned = pinned
    status('')
    renderProjects()
  } catch (error) {
    status(error.message, true)
  } finally {
    pinRequests.delete(projectId)
    renderPin()
    schedulePoll(0)
  }
}

function renderArchiveControls(matches) {
  const visibleIds = new Set(matches.map(project => project.id))
  for (const id of selectedProjects) {
    if (!visibleIds.has(id)) selectedProjects.delete(id)
  }
  const size = selectedProjects.size
  const action = projectState === 'archived' ? '恢复所选' : '归档所选'
  projectManage.setAttribute('aria-pressed', String(managingProjects))
  projectManage.hidden = !archiveAvailable
  projectManage.disabled = archiveBusy || catalog.length === 0
  byId('project-bulk').hidden = !managingProjects
  selectVisible.checked = size > 0 && size === matches.length
  selectVisible.indeterminate = size > 0 && size < matches.length
  selectVisible.disabled = archiveBusy || matches.length === 0
  bulkArchive.textContent = size ? `${action} · ${size}` : action
  bulkArchive.disabled = archiveBusy || size === 0
  projectUndo.disabled = archiveBusy
  archiveAction.hidden = !archiveAvailable
  archiveAction.disabled = archiveBusy || detailLoading || !current
}

function projectRow(project, matches) {
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
  if (!managingProjects) return button
  const row = text('div', '', 'project-row')
  const check = document.createElement('input')
  check.id = `check-project-${project.id}`
  check.className = 'project-check'
  check.type = 'checkbox'
  check.checked = selectedProjects.has(project.id)
  check.disabled = archiveBusy
  check.setAttribute('aria-label', `选择 ${project.name}`)
  check.addEventListener('change', () => {
    if (check.checked) selectedProjects.add(project.id)
    else selectedProjects.delete(project.id)
    renderArchiveControls(matches)
  })
  row.append(check, button)
  return row
}

function renderProjects() {
  syncSearch(projectSearch)
  const base = projectMatches()
  const matches = filteredProjects(base)
  const active = base.filter(project => !project.archived)
  const online = active.filter(project => project.online).length
  const counts = { all: active.length, online, offline: active.length - online, archived: base.length - active.length }
  const labels = { all: '未归档', online: '可接续', offline: '离线', archived: '已归档' }
  for (const button of projectFilters) {
    const state = button.dataset.projectState
    button.hidden = state === 'archived' && !archiveAvailable
    button.setAttribute('aria-pressed', String(projectState === state))
    button.replaceChildren(document.createTextNode(labels[state]), text('span', counts[state], 'filter-count'))
  }
  const total = catalog.filter(project => Boolean(project.archived) === (projectState === 'archived')).length
  byId('project-count').textContent = matches.length === total ? `${total} 项` : `${matches.length} / ${total}`
  renderArchiveControls(matches)
  const items = []
  for (const [label, group] of projectGroups(matches)) {
    if (!group.length) continue
    if (label) items.push(text('h3', label, 'project-group-heading'))
    for (const project of group) items.push(projectRow(project, matches))
  }
  const focused = projectList.contains(document.activeElement) ? document.activeElement.id : ''
  const scroll = projectList.scrollTop
  const emptyMessage = projectState === 'archived' ? '没有匹配的归档项目。' : '没有匹配的项目。'
  projectList.replaceChildren(...(items.length ? items : [text('p', emptyMessage, 'asset-empty')]))
  projectList.scrollTop = scroll
  if (focused) byId(focused)?.focus({ preventScroll: true })
}

function archiveFeedback(message, error = false) {
  const feedback = byId('project-feedback')
  feedback.hidden = !message
  feedback.classList.toggle('error', error)
  byId('project-feedback-text').textContent = message
  projectUndo.hidden = !undoArchive
}

function emptyProjectDetail(message) {
  current = undefined
  detail = undefined
  context = undefined
  detailLoading = false
  ++detailRevision
  byId('empty').textContent = message
  byId('empty').hidden = false
  byId('project-detail').hidden = true
  byId('preview').disabled = true
}

function reconcileProject(matches, selectFirst = false) {
  if (current && matches.some(project => project.id === current.id)) return
  if (selectFirst && matches.length) {
    const [, firstGroup] = projectGroups(matches).find(([, group]) => group.length)
    void selectProject(firstGroup[0])
  } else if (matches.length) emptyProjectDetail('从项目列表选择要接续的项目。')
  else if (catalog.length) emptyProjectDetail('当前筛选下没有项目。')
  else if (catalogLoaded) emptyProjectDetail('未找到可浏览的项目。请展开本机来源查看读取状态。')
}

function updateProjectView() {
  reconcileProject(filteredProjects())
  renderProjects()
}

function updateProjectSearch() {
  projectQuery = projectSearch.value.trim().toLowerCase()
  updateProjectView()
}

async function updateProjectArchive(projectIds, archived, undo = false) {
  if (!projectIds.length || archiveBusy) return
  if (refreshing) {
    archiveFeedback('正在刷新项目，请稍后重试。', true)
    return
  }
  const origin = document.activeElement
  archiveBusy = true
  renderProjects()
  try {
    const result = await api('set-project-archive', { projectIds, archived })
    const updated = new Set(result.projectIds)
    for (const project of catalog) {
      if (updated.has(project.id)) project.archived = archived
    }
    if (updated.has(current?.id)) current.archived = archived
    reconcileProject(filteredProjects(), true)
    selectedProjects.clear()
    const changed = result.changedProjectIds
    undoArchive = !undo && changed.length ? { projectIds: changed, archived: !archived } : undefined
    archiveFeedback(changed.length ? `已${archived ? '归档' : '恢复'} ${changed.length} 个项目` : '项目已处于所选状态。')
  } catch (error) {
    archiveFeedback(error.message, true)
  } finally {
    archiveBusy = false
    renderProjects()
    if (document.activeElement === document.body && [archiveAction, bulkArchive, projectUndo].includes(origin)) {
      if (origin === bulkArchive && !selectVisible.disabled) selectVisible.focus({ preventScroll: true })
      else projectFilters.find(button => button.dataset.projectState === projectState)?.focus({ preventScroll: true })
    }
    schedulePoll(0)
  }
}

function renderSelection() {
  if (!context) return
  const entries = context.entries.filter(item => selected.has(item.id))
  const skillCount = entries.filter(item => item.kind === 'skill').length
  const memoryCount = entries.length - skillCount
  const parts = [memoryCount ? `${memoryCount} 份记忆` : '', skillCount ? `${skillCount} 个 Skills` : ''].filter(Boolean)
  const summary = parts.join('、') || '未选资料'
  byId('selection-summary').textContent = `接续清单 · ${summary}${historyOption.checked ? ' + 摘录' : ''}`
  const globalCount = entries.filter(item => item.global).length
  byId('selection-global').textContent = `${globalCount} 项全局`
  byId('selection-global').hidden = globalCount === 0
  renderGlobalCount()
  const focused = queueList.contains(document.activeElement) ? document.activeElement.id : ''
  const scroll = queueList.scrollTop
  queueList.replaceChildren(...(entries.length ? entries.map(item => {
    const row = text('div', '', 'queue-item')
    const title = materialName(item)
    const name = text('span', title, 'queue-title')
    name.title = title
    const kindLabel = text('span', `${item.global ? '全局 ' : ''}${item.kind === 'memory' ? '记忆' : 'Skill'}`, 'queue-kind')
    const remove = text('button', '', 'queue-remove icon-button')
    remove.type = 'button'
    remove.id = `queue-remove-${item.id}`
    remove.setAttribute('aria-label', `移除 ${title}`)
    remove.append(icon('close'))
    remove.addEventListener('click', () => {
      const next = row.nextElementSibling ?? row.previousElementSibling
      const focusId = next?.querySelector('.queue-remove')?.id
      selected.delete(item.id)
      void saveProjectSelection()
      renderAssets()
      const focusTarget = byId(focusId) ?? byId('handoff').querySelector('summary')
      focusTarget.focus({ preventScroll: true })
    })
    row.append(icon(item.kind, 'queue-icon'), name, kindLabel, remove)
    return row
  }) : [text('p', '尚未选择记忆或 Skills。', 'queue-empty')]))
  queueList.scrollTop = scroll
  if (focused) byId(focused)?.focus({ preventScroll: true })
}

function saveProjectSelection() {
  if (!current || !detail) return
  const projectId = current.id
  projectSelections.set(projectId, { assetIds: [...selected], history: includeHistory })
  if (!preferencesAvailable || selectionSaves.has(projectId)) return
  selectionSaves.set(projectId, flushProjectSelection(projectId))
}

async function flushProjectSelection(projectId) {
  try {
    while (projectSelections.has(projectId)) {
      const selection = projectSelections.get(projectId)
      try {
        await api('set-project-selection', { projectId, ...selection }, { keepalive: true })
        if (projectSelections.get(projectId) === selection) projectSelections.delete(projectId)
      } catch (error) {
        if (projectSelections.get(projectId) !== selection) continue
        if (current?.id === projectId) status(`勾选已保留在当前面板。${error.message}`, true)
        return
      }
    }
  } finally {
    selectionSaves.delete(projectId)
  }
}

function materialName(asset) {
  if (asset.kind === 'skill') return asset.name
  if (/^memory[-_]summary$/i.test(asset.name)) return '记忆摘要'
  if (/^memory$/i.test(asset.name)) return asset.global ? '长期记忆' : '项目记忆'
  if (asset.group === 'guides' && /^(?:AGENTS|CLAUDE|GEMINI|QWEN|USER|SOUL)$/i.test(asset.name)) {
    const label = asset.agent === 'shared' ? '' : `${agentName(asset.agent)} `
    return label + (asset.global ? '全局指引' : '项目指引')
  }
  if (/^current[- _]state$/i.test(asset.name)) return '当前状态'
  if (/^latest[- _]handoff$/i.test(asset.name)) return '最新交接'
  return asset.name
}

function matchesMaterial(asset, query) {
  return [materialName(asset), asset.name, agentName(asset.agent), asset.file, asset.detail]
    .some(value => value?.toLowerCase().includes(query))
}

function renderGlobalCount() {
  const assets = context.entries.filter(asset => asset.global)
  const query = assetSearch.value.trim().toLowerCase()
  const count = query ? assets.filter(asset => matchesMaterial(asset, query)).length : assets.length
  const checked = assets.filter(asset => selected.has(asset.id)).length
  globalLibrary.hidden = assets.length === 0
  byId('global-count').textContent = `${count} ${query ? '项匹配' : '项'}${checked ? ` · ${checked} 已选` : ''}`
}

function makeMaterialRow(asset) {
  const name = materialName(asset)
  const row = text('div', '', 'asset-row')
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.className = 'asset-check'
  checkbox.id = `asset-${asset.id}`
  checkbox.checked = selected.has(asset.id)
  row.dataset.selected = String(checkbox.checked)
  checkbox.addEventListener('change', () => {
    if (checkbox.checked && selected.size >= 24) {
      checkbox.checked = false
      status('每次最多选择 24 项资料。', true, 'selection-feedback')
      return
    }
    if (checkbox.checked) selected.add(asset.id)
    else selected.delete(asset.id)
    row.dataset.selected = String(checkbox.checked)
    status('', false, 'selection-feedback')
    renderSelection()
    void saveProjectSelection()
  })
  const label = text('label', '', 'asset-label')
  label.htmlFor = checkbox.id
  label.title = name === asset.name ? asset.file : `${asset.name}\n${asset.file}`
  const title = text('span', name, 'asset-title')
  const meta = text('span', '', 'asset-meta')
  if (asset.agent) meta.append(agentLabel(asset.agent))
  if (!asset.global && context.suggestedIds.includes(asset.id)) {
    meta.append(text('span', '建议带入', 'material-suggestion'))
  } else if (asset.global && asset.used) {
    meta.append(text('span', '近期会话提及', 'material-suggestion'))
  }
  label.append(title, meta)
  const button = text('button', '', 'asset-view')
  button.append(document.createTextNode('查看'), icon('chevron'))
  button.type = 'button'
  button.id = `asset-view-${asset.id}`
  button.setAttribute('aria-label', `查看 ${name}`)
  button.addEventListener('click', () => viewAsset(asset))
  const marker = text('span', '', 'asset-icon')
  marker.append(icon(asset.kind))
  row.append(checkbox, marker, label, button)
  return row
}

function fillMaterials(target, groups, assets, emptyMessage) {
  const scroll = target.scrollTop
  const focused = target.contains(document.activeElement) ? document.activeElement.id : ''
  const sections = groups.flatMap(([key, title, note]) => {
    const members = assets.filter(item => item.group === key)
    if (!members.length) return []
    const group = text('section', '', 'asset-group')
    const heading = text('h4', title, 'asset-group-heading')
    heading.append(text('span', String(members.length), 'disclosure-count'))
    group.append(heading)
    if (note) group.append(text('p', note, 'asset-group-note'))
    group.append(...members.map(makeMaterialRow))
    return [group]
  })
  target.replaceChildren(...(sections.length ? sections : [text('p', emptyMessage, 'asset-empty')]))
  target.scrollTop = scroll
  if (focused) byId(focused)?.focus({ preventScroll: true })
}

function renderGlobalMaterials() {
  if (!context || !globalLibrary.open) return
  const query = assetSearch.value.trim().toLowerCase()
  fillMaterials(globalMaterials, globalGroups, context.entries.filter(item => item.global && matchesMaterial(item, query)), '没有匹配的全局资料。')
}

function renderAssets() {
  if (!context || !draftWorkflow.open) return
  const query = assetSearch.value.trim().toLowerCase()
  syncSearch(assetSearch)
  fillMaterials(projectMaterials, materialGroups, context.entries.filter(item => !item.global && matchesMaterial(item, query)),
    query ? '没有匹配的项目资料。' : '没有找到项目专用资料。你也可以直接预览草稿。')
  renderGlobalMaterials()
  renderSelection()
}

function applyDetail(project, loaded, preserve) {
  showProject(loaded.project ?? project)
  detail = loaded
  context = describeProjectContext(loaded)
  if (!preserve) {
    const saved = projectSelections.get(project.id) ?? loaded.selection
    if (saved) {
      selected = new Set(saved.assetIds)
      includeHistory = saved.history
    } else {
      selected = new Set(context.suggestedIds)
      includeHistory = false
    }
  }
  const available = new Set(context.entries.map(item => item.id))
  selected = new Set([...selected].filter(id => available.has(id)))
  historyOption.checked = includeHistory && detail.historyCount > 0
  historyOption.disabled = detail.historyCount === 0
  byId('history-option').hidden = detail.historyCount === 0
  byId('history-label').textContent = `带入近期对话摘录（最多 ${Math.min(8, detail.historyCount)} 条消息）`
  byId('preview').disabled = false
  assetSearch.disabled = false
  renderAssets()
}

function showProject(project) {
  const latest = catalog.find(item => item.id === project.id) ?? project
  current = { ...project, archived: Boolean(latest.archived), pinned: Boolean(latest.pinned) }
  byId('project-name').textContent = current.name
  byId('project-path').textContent = current.cwd
  byId('project-path').title = current.cwd
  const availability = text('span', current.online ? '原目录可用' : '原目录不可访问', 'chip availability')
  availability.dataset.state = current.online ? 'online' : 'offline'
  byId('project-meta').replaceChildren(...current.projectIds.map(value => text('span', value, 'chip')),
    ...current.agents.map(agent => agentLabel(agent, 'chip')), availability)
  if (current.archived) {
    const archived = text('span', '已归档', 'chip')
    archived.dataset.state = 'archived'
    byId('project-meta').append(archived)
  }
  byId('project-archive-action-label').textContent = current.archived ? '恢复项目' : '归档项目'
  byId('project-archive-action-icon').setAttribute('href', current.archived ? '#icon-restore' : '#icon-archive')
  archiveAction.disabled = archiveBusy
  renderPin()
  byId('empty').hidden = true
  byId('project-detail').hidden = false
}

function revealProjectDetail() {
  if (!compactLayout.matches) return
  const heading = byId('project-name')
  heading.focus({ preventScroll: true })
  heading.closest('.detail').scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'instant' : 'smooth' })
}

function makeConversationRow(session, open) {
  const row = text('li', '', 'conversation-item')
  const button = text('button', '', 'conversation-row')
  button.type = 'button'
  button.dataset.session = session.id
  const title = session.title || '未命名对话'
  button.title = title
  const info = text('span', '', 'conversation-info')
  const meta = text('span', agentName(session.agent), 'conversation-meta')
  if (session.archivedSource) meta.append(text('span', ' · 本地存档'))
  const date = new Date(session.date)
  if (session.date > 0 && Number.isFinite(date.getTime())) {
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const day = date.toDateString()
    const display = day === today.toDateString() ? `今天 ${shortClock.format(date)}`
      : day === yesterday.toDateString() ? `昨天 ${shortClock.format(date)}`
        : date.getFullYear() === today.getFullYear() ? recentDateFormat.format(date) : historyDateFormat.format(date)
    const timestamp = text('time', display)
    timestamp.dateTime = date.toISOString()
    timestamp.title = historyDateFormat.format(date)
    meta.append(text('span', ' · '), timestamp)
  }
  info.append(text('span', title, 'conversation-title'), meta)
  const action = text('span', '', 'conversation-action')
  action.append(text('span', '预览'), icon('chevron'))
  button.append(agentMark(session.agent), info, action)
  button.addEventListener('click', () => open(session))
  row.append(button)
  return row
}

function resetRecentConversations() {
  recentRevision++
  recentKey = ''
  recentList.replaceChildren()
  browseHistory.hidden = true
}

async function loadRecentConversations(project) {
  const revision = ++recentRevision
  const isCurrent = () => current?.id === project.id && recentRevision === revision
  if (!nativeSessionImport || !project.hasConversations) {
    resetRecentConversations()
    recentStatus.textContent = nativeSessionImport
      ? '这个项目还没有可迁入的对话。可以用项目资料开新对话。'
      : '当前 DSH 不支持迁入旧对话。可以用项目资料开新对话。'
    return
  }
  if (!recentKey) recentStatus.textContent = '正在查找最近对话…'
  try {
    const { sessions, total } = await api('list-conversations', { projectId: project.id, recent: true })
    if (!isCurrent()) return
    const key = JSON.stringify(sessions)
    if (key !== recentKey) {
      const active = recentList.contains(document.activeElement) ? document.activeElement.dataset.session : ''
      recentList.replaceChildren(...sessions.map(session => makeConversationRow(session, item => openSourceConversation(item))))
      if (active) ([...recentList.querySelectorAll('button')].find(button => button.dataset.session === active)
        ?? byId('continue-heading')).focus({ preventScroll: true })
      recentKey = key
    }
    recentStatus.textContent = sessions.length
      ? (current.online ? '' : '原工作目录不可访问，暂时只能预览。')
      : '这个项目还没有可迁入的对话。可以用项目资料开新对话。'
    byId('browse-history-label').textContent = `查看全部 ${total ?? sessions.length} 条对话`
    browseHistory.hidden = (total ?? sessions.length) <= sessions.length
  } catch {
    if (!isCurrent()) return
    recentStatus.textContent = recentList.childElementCount
      ? '暂时无法刷新对话列表，可稍后重试。'
      : '暂时读不到对话列表。可以刷新来源，或用项目资料开新对话。'
  }
}

async function selectProject(project, reveal = false) {
  if (!filteredProjects().some(item => item.id === project.id)) return
  if (current?.id === project.id && (detail || detailLoading)) {
    if (reveal) revealProjectDetail()
    return
  }
  const revision = ++detailRevision
  detail = undefined
  context = undefined
  detailLoading = true
  selected = new Set()
  assetSearch.value = ''
  syncSearch(assetSearch)
  draftWorkflow.open = false
  globalLibrary.open = false
  globalLibrary.hidden = true
  byId('handoff').open = false
  byId('history-option').hidden = true
  byId('selection-global').hidden = true
  byId('selection-summary').textContent = '接续清单'
  byId('preview').disabled = true
  assetSearch.disabled = true
  status('', false, 'selection-feedback')
  projectMaterials.replaceChildren(text('p', '正在读取项目资料…', 'asset-empty'))
  globalMaterials.replaceChildren()
  queueList.replaceChildren()
  resetRecentConversations()
  showProject(project)
  renderProjects()
  if (reveal) revealProjectDetail()
  void loadRecentConversations(project)
  try {
    const pendingSelection = selectionSaves.get(project.id)
    if (pendingSelection) await pendingSelection
    if (revision !== detailRevision) return
    const loaded = await api('detail', { projectId: project.id })
    if (revision !== detailRevision) return
    applyDetail(project, loaded, false)
  } catch (error) {
    if (revision === detailRevision) projectMaterials.replaceChildren(text('p', error.message, 'asset-empty error'))
  } finally {
    if (revision === detailRevision) detailLoading = false
  }
}

function canAutoRefresh() {
  return document.visibilityState === 'visible' && !dialog.open && agentPopover.hidden && !detailLoading && !archiveBusy
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
  if (refreshing || archiveBusy || (automatic && !canAutoRefresh())) return false
  refreshing = true
  refreshButton.disabled = true
  refreshButton.dataset.loading = 'true'
  if (!automatic) status(force ? '正在重新扫描本机来源…' : '正在扫描本机来源…')
  try {
    const result = await api('catalog', { refresh: force })
    if (dialog.open || (automatic && !canAutoRefresh())) return false
    if (result.revision < lastPinRevision) return false
    const firstLoad = !catalogLoaded
    catalogLoaded = true
    catalog = result.projects
    archiveAvailable = catalog.every(project => typeof project.archived === 'boolean')
    nativeSessionImport = result.nativeSessionImport === true
    preferencesAvailable = catalog.every(project => typeof project.pinned === 'boolean')
    agentIcons = result.agentIcons ?? {}
    const activeAgent = availableAgents[activeAgentIndex]
    availableAgents = ['', ...[...new Set([selectedAgent, ...catalog.flatMap(project => project.agents)])]
      .filter(Boolean).sort((left, right) => agentName(left).localeCompare(agentName(right), 'zh-CN'))]
    renderAgentPicker(activeAgent)
    renderSources(result.sources)
    if (!archiveAvailable || !preferencesAvailable) status('请完全退出 DSH 并重新打开，加载新版插件。')
    else if (!automatic) status('')
    const matches = filteredProjects()
    reconcileProject(matches, firstLoad)
    renderProjects()
    const previous = matches.find(project => project.id === current?.id)
    const revision = detailRevision
    if (previous && !detailLoading) {
      if (!detail) {
        void selectProject(previous)
      } else {
        showProject(previous)
        void loadRecentConversations(previous)
        const loaded = await api('detail', { projectId: previous.id })
        if (revision === detailRevision && !dialog.open) applyDetail(previous, loaded, true)
      }
    }
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
  recoverDraftButton.disabled = busy
  exportButton.disabled = busy
  sessionSelect.disabled = busy
  byId('history-back-button').disabled = busy
  historyImport.disabled = busy
}

function showDialog(mode, title, note, body, assetKind = 'memory') {
  dialogMode = mode
  dialog.dataset.mode = mode
  ticket = undefined
  nativeSessions = []
  historyProject = undefined
  historySessions = undefined
  historyChosenId = undefined
  historyTicket = undefined
  importedSessionId = undefined
  draftRecovery = undefined
  clearDownload()
  byId('dialog-title').textContent = title
  byId('dialog-note').textContent = note
  byId('dialog-mark').replaceChildren(icon(mode === 'session' ? 'download' : mode === 'asset' ? assetKind : mode === 'history' ? 'history' : 'bridge'))
  dialogText.hidden = false
  dialogText.dataset.format = 'plain'
  dialogText.textContent = body
  dialogText.closest('.dialog-content').scrollTop = 0
  byId('session-choice').hidden = true
  byId('history-choice').hidden = true
  byId('history-back').hidden = true
  status('', false, 'dialog-status')
  importButton.hidden = true
  recoverDraftButton.hidden = true
  exportButton.hidden = true
  historyImport.hidden = true
  setDialogBusy(false)
  if (!dialog.open) dialog.showModal()
  clearTimeout(pollTimer)
  liveState('实时扫描已暂停')
  return ++dialogEpoch
}

function startHistoryDialog(title, note, body) {
  const project = current
  if (dialog.open || !project || !nativeSessionImport || !filteredProjects().some(item => item.id === project.id)) return
  const epoch = showDialog('history', title, note, body)
  historyProject = project
  return epoch
}

const historyNote = '迁入用户与助手的文字消息。工具记录、附件和运行状态留在来源 Agent。'

function openSourceConversation(session) {
  if (startHistoryDialog('继续旧对话', historyNote, '正在读取这条对话…') === undefined) return
  void previewSourceConversation(session)
}

async function chooseSourceConversation() {
  const epoch = startHistoryDialog('查看全部对话', '选择一条对话以预览历史消息。', '正在读取对话列表…')
  if (epoch === undefined) return
  try {
    const { sessions } = await api('list-conversations', { projectId: historyProject.id })
    if (!dialog.open || dialogEpoch !== epoch) return
    historySessions = sessions
    historySearch.value = ''
    historyLimit = 30
    showHistoryResults()
  } catch (error) {
    if (dialog.open && dialogEpoch === epoch) dialogText.textContent = error.message
  }
}

function renderHistoryResults() {
  const query = historySearch.value.trim().toLowerCase()
  syncSearch(historySearch)
  const matches = historySessions.filter(session => [session.title, agentName(session.agent)]
    .some(value => value?.toLowerCase().includes(query)))
  historyResults.replaceChildren(...matches.slice(0, historyLimit).map(session => makeConversationRow(session, previewSourceConversation)))
  byId('history-empty').textContent = matches.length ? '' : (query ? '没有找到匹配的对话。' : '这个项目暂无可迁入的对话。')
  byId('history-more').hidden = matches.length <= historyLimit
}

function showHistoryResults() {
  if (!historySessions) return
  historyPreview++
  historyTicket = undefined
  importedSessionId = undefined
  historyImport.hidden = true
  byId('history-back').hidden = true
  byId('dialog-title').textContent = '查看全部对话'
  byId('dialog-note').textContent = '选择一条对话以预览历史消息。'
  dialogText.hidden = true
  byId('history-choice').hidden = false
  status('', false, 'dialog-status')
  renderHistoryResults()
  dialogText.closest('.dialog-content').scrollTop = 0
  const previous = historyChosenId && [...historyResults.querySelectorAll('button')].find(button => button.dataset.session === historyChosenId)
  ;(previous || historySearch).focus()
}

async function previewSourceConversation(session) {
  const epoch = dialogEpoch
  const revision = ++historyPreview
  historyChosenId = session.id
  historyTicket = undefined
  importedSessionId = undefined
  historyImport.hidden = true
  byId('history-import-label').textContent = '迁入并继续'
  byId('history-choice').hidden = true
  byId('history-back').hidden = !historySessions
  byId('dialog-title').textContent = '继续旧对话'
  byId('dialog-note').textContent = historyNote
  dialogText.hidden = false
  dialogText.dataset.format = 'plain'
  dialogText.textContent = '正在读取这条对话…'
  dialogText.closest('.dialog-content').scrollTop = 0
  if (historySessions) byId('history-back-button').focus()
  else dialogText.focus({ preventScroll: true })
  status('', false, 'dialog-status')
  try {
    const result = await api('preview-conversation', { projectId: historyProject.id, sessionId: session.id })
    if (!dialog.open || dialogEpoch !== epoch || revision !== historyPreview) return
    historyTicket = result.ticket
    const title = text('h3', result.title, 'preview-lead')
    const source = text('p', '', 'preview-context history-source')
    source.append(agentLabel(session.agent), text('code', result.cwd || historyProject.cwd, 'preview-source'))
    const summary = text('p', [
      result.messages.length + ' 条文字消息',
      result.truncated ? '源记录或读取范围有限，部分历史未带入' : '',
      result.canImport ? '' : '原工作目录不可访问，当前可预览',
    ].filter(Boolean).join(' · '), 'preview-context')
    dialogText.dataset.format = 'history'
    dialogText.replaceChildren(title, source, summary, ...result.messages.map(message => {
      const row = text('section', '', 'history-message')
      row.dataset.role = message.role
      row.append(text('h3', message.role === 'user' ? '用户' : '助手'), text('p', message.text, 'preview-body'))
      return row
    }))
    historyImport.hidden = !result.canImport
  } catch (error) {
    if (dialog.open && dialogEpoch === epoch && revision === historyPreview) dialogText.textContent = error.message
  }
}

async function importSourceConversation() {
  if (!historyTicket || dialogBusy) return
  setDialogBusy(true)
  status(importedSessionId ? '正在打开已迁入的会话…' : '正在迁入会话…', false, 'dialog-status')
  try {
    if (!importedSessionId) {
      const result = await api('import-conversation', { ticket: historyTicket })
      importedSessionId = result.sessionId
    }
    await requestParent('open-imported', { sessionId: importedSessionId })
    dialog.close()
    status('历史已迁入。打开会话即可继续。')
  } catch (error) {
    if (importedSessionId) byId('history-import-label').textContent = '打开已迁入会话'
    status(error.message, true, 'dialog-status')
  } finally {
    setDialogBusy(false)
  }
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
  const epoch = showDialog('asset', materialName(asset), asset.file, '正在读取…', asset.kind)
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
  if (!project || !detail || !filteredProjects().some(item => item.id === project.id)) return
  const note = project.online
    ? '可导出 Markdown，或在原工作目录打开 DSH 会话并继续编辑草稿。'
    : '原工作目录不可访问。可将现有交接资料导出为 Markdown。'
  const epoch = showDialog('handoff', `草稿预览 · ${project.name}`, note, '正在准备…')
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
  status(draftRecovery ? '正在重试填入草稿…' : '正在创建 DSH 会话…', false, 'dialog-status')
  try {
    const { path, prompt } = await api('open', { ticket })
    await requestParent('open', { path, prompt, bridgeNonce: nonce }, ticket)
    ticket = undefined
    dialog.close()
    status('DSH 会话已打开。交接草稿已填入输入框。')
  } catch (error) {
    if (Object.hasOwn(error, 'recoverySessionId')) draftRecovery = error.recoverySessionId
    recoverDraftButton.hidden = !draftRecovery
    status(error.message, true, 'dialog-status')
  } finally {
    setDialogBusy(false)
  }
}

async function recoverDraftSession() {
  if (!ticket || !draftRecovery || dialogBusy) return
  setDialogBusy(true)
  try {
    await requestParent('recover-draft', { sessionId: draftRecovery }, ticket)
    dialog.close()
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
  else request.reject(Object.assign(new Error(data.error || 'DSH 暂无法完成此操作。'), {
    recoverySessionId: typeof data.recoverySessionId === 'string' ? data.recoverySessionId : undefined,
  }))
})
refreshButton.addEventListener('click', () => refresh(true))
projectSearch.addEventListener('input', event => {
  if (!event.isComposing) updateProjectSearch()
})
projectSearch.addEventListener('compositionend', updateProjectSearch)
projectSearch.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || !['ArrowDown', 'Enter'].includes(event.key)) return
  const first = projectList.querySelector('.project')
  if (!first) return
  event.preventDefault()
  first.focus()
  if (event.key === 'Enter') first.click()
})
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
wireClear(projectSearch, updateProjectSearch)
wireClear(assetSearch, renderAssets)
draftWorkflow.addEventListener('toggle', renderAssets)
globalLibrary.addEventListener('toggle', renderGlobalMaterials)
projectManage.addEventListener('click', () => {
  managingProjects = !managingProjects
  selectedProjects.clear()
  renderProjects()
})
selectVisible.addEventListener('change', () => {
  selectedProjects.clear()
  if (selectVisible.checked) {
    for (const project of filteredProjects()) selectedProjects.add(project.id)
  }
  renderProjects()
})
bulkArchive.addEventListener('click', () => updateProjectArchive([...selectedProjects], projectState !== 'archived'))
archiveAction.addEventListener('click', () => {
  if (current) void updateProjectArchive([current.id], !current.archived)
})
projectPin.addEventListener('click', toggleProjectPin)
projectUndo.addEventListener('click', () => {
  if (undoArchive) void updateProjectArchive(undoArchive.projectIds, undoArchive.archived, true)
})
for (const button of projectFilters) {
  button.addEventListener('click', () => {
    projectState = button.dataset.projectState
    projectList.scrollTop = 0
    updateProjectView()
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
  void saveProjectSelection()
})
byId('copy-path').addEventListener('click', copyProjectPath)
byId('preview').addEventListener('click', preview)
byId('native-export').addEventListener('click', chooseNativeSession)
browseHistory.addEventListener('click', chooseSourceConversation)
byId('history-back-button').addEventListener('click', showHistoryResults)
function searchHistory() {
  historyChosenId = undefined
  historyLimit = 30
  renderHistoryResults()
}
historySearch.addEventListener('input', searchHistory)
wireClear(historySearch, searchHistory)
byId('history-more').addEventListener('click', () => {
  const index = historyResults.childElementCount
  historyLimit += 30
  renderHistoryResults()
  historyResults.children[index]?.querySelector('button')?.focus()
})
historyImport.addEventListener('click', importSourceConversation)
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
recoverDraftButton.addEventListener('click', recoverDraftSession)
exportButton.addEventListener('click', exportMarkdown)
document.addEventListener('visibilitychange', () => schedulePoll(0))
for (const button of themeOptions) button.addEventListener('click', () => setTheme(button.dataset.themeChoice))
let savedTheme
try { savedTheme = localStorage.getItem(themeKey) } catch { /* Use the default theme. */ }
setTheme(savedTheme, false)
renderAgentPicker()
void refresh(false).finally(() => schedulePoll(0))
