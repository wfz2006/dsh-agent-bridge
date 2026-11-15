const currentStatus = /^(?:当前状态|最新交接|current[- _]state|latest[- _]handoff)(?:$|[\s:_-])/i

export function describeProjectContext({ memories, skills }) {
  const entries = [...memories.map(asset => describe(asset, 'memory')), ...skills.map(asset => describe(asset, 'skill'))]
  const candidates = entries.filter(item => !item.global && item.group === 'progress' && item.agent !== 'export')
  const named = candidates.filter(item => currentStatus.test(item.name))
  const preferred = named.length ? named : candidates
  const suggestedIds = [
    ...(preferred.length === 1 ? [preferred[0].id] : []),
    ...entries.filter(item => item.group === 'used').slice(0, 3).map(item => item.id),
  ]
  return { entries, suggestedIds }
}

function describe(asset, kind) {
  // The project registry has already verified WorkspaceHub notes against this working directory.
  const hubNote = kind === 'memory' && asset.agent === 'workspacehub' && asset.scope === 'shared'
  const global = asset.scope !== 'project' && !hubNote
  let group
  if (kind === 'skill') group = !global && asset.used ? 'used' : 'skills'
  else if (!global && (asset.detail === '项目交接' || (hubNote && asset.detail?.endsWith(' · 交接')) || currentStatus.test(asset.name))) group = 'progress'
  else if (['用户指引', '项目指引'].includes(asset.detail) && !/^memory$/i.test(asset.name)) group = 'guides'
  else group = 'notes'
  return { ...asset, kind, global, group }
}
