import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const run = promisify(execFile)
const builder = fileURLToPath(new URL('../scripts/build-skill.mjs', import.meta.url))
const date = '2026-11-19'
const secret = 'sk-fixture-abcdefghijklmno'

test('the independently installed DSH skill selects the requested conversation and project memory', async t => {
  const temp = await realpath(tmpdir())
  const root = await mkdtemp(path.join(temp, 'agent-bridge-skill-'))
  t.after(async () => {
    const target = await realpath(root)
    assert.equal(path.dirname(target), temp)
    assert.match(path.basename(target), /^agent-bridge-skill-/)
    await rm(target, { recursive: true, force: true })
  })
  const project = path.join(root, '项目 with spaces')
  const other = path.join(root, 'other-project')
  const home = path.join(root, 'dsh')
  const codex = path.join(root, 'codex')
  const day = path.join(codex, 'sessions', ...date.split('-'))
  const memory = path.join(project, '.agent-bridge', 'memory')
  const globalMemory = path.join(codex, 'memories_v2')
  await Promise.all([other, home, day, memory, globalMemory].map(dir => mkdir(dir, { recursive: true })))
  await writeFile(path.join(memory, 'progress.md'), 'Use the approved approach.\n')
  await writeFile(path.join(globalMemory, 'unrelated-global.md'), 'GLOBAL_PRIVATE\n')
  const rows = (cwd, id, question, reply) => [
    { type: 'session_meta', payload: { cwd, id } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  await Promise.all([
    writeFile(path.join(day, 'rollout-2026-11-19T12-00-00-new.jsonl'), rows(project, 'new', 'Latest chat', 'Latest reply')),
    writeFile(path.join(day, 'rollout-2026-11-19T11-00-00-old.jsonl'), rows(project, 'old', 'Selected chat', `Selected reply ${secret}`)),
    writeFile(path.join(day, 'rollout-2026-11-19T13-00-00-other.jsonl'), rows(other, 'other', 'OTHER_PROJECT_PRIVATE', 'Other reply')),
    writeFile(path.join(home, 'agent-bridge.json'), JSON.stringify({ agentRoots: { codex: [codex] } })),
  ])
  for (const [name, hour] of [['old', 11], ['new', 12], ['other', 13]]) {
    const updated = new Date(`${date}T${hour}:00:00Z`)
    await utimes(path.join(day, `rollout-${date}T${hour}-00-00-${name}.jsonl`), updated, updated)
  }
  const staged = path.join(root, 'dist')
  await run(process.execPath, [builder, staged], { cwd: other })
  const installed = path.join(home, 'skills', 'agent-bridge')
  await mkdir(path.dirname(installed))
  await rename(path.join(staged, 'agent-bridge'), installed)
  assert.match(await readFile(path.join(installed, 'SKILL.md'), 'utf8'), /^---\r?\nname: agent-bridge\b/)
  const cli = path.join(installed, 'scripts', 'runtime', 'src', 'skill-cli.js')
  const env = { ...process.env, DSH_HOME: home, DSH_AGENT_BRIDGE_CONFIG: path.join(home, 'agent-bridge.json') }
  const cliArgs = [cli, '--project', project, '--agent', 'codex']
  const invoke = args => run(process.execPath, [cliArgs[0], ...args, ...cliArgs.slice(1)], { cwd: other, env })

  const { stdout: metadata } = await invoke(['inspect'])
  const inspected = JSON.parse(metadata)
  assert.deepEqual(inspected.conversations.map(item => item.title), ['Latest chat', 'Selected chat'])
  assert.doesNotMatch(metadata, /OTHER_PROJECT_PRIVATE|Selected reply|Use the approved approach|unrelated-global/)
  const session = inspected.conversations.find(item => item.title === 'Selected chat').id
  const asset = inspected.memories.find(item => item.name === 'progress').id
  const { stdout: draft } = await invoke(['handoff', '--session', session, '--asset', asset])
  assert.match(draft, /Selected chat[\s\S]*Selected reply \[已隐藏凭据\]/)
  assert.match(draft, /Use the approved approach/)
  assert.doesNotMatch(draft, /Latest chat|OTHER_PROJECT_PRIVATE|sk-fixture/)
  const { stdout: latest } = await invoke(['handoff'])
  assert.match(latest, /Latest reply/)
  assert.doesNotMatch(latest, /Selected reply|Use the approved approach/)

  const { stdout: exported } = await invoke(['handoff', '--no-history', '--asset', asset, '--format', 'share'])
  assert.match(exported, /^# 项目 with spaces · 开发交接\n/)
  assert.match(exported, /Use the approved approach/)
  assert.doesNotMatch(exported, /file:\/\/|Selected chat|Latest chat/)

  const bad = spawnSync(process.execPath, [cli, 'handoff', '--project', other, '--agent', 'codex', '--session', session],
    { env, encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.equal(bad.stdout, '')
  assert.match(bad.stderr, /会话不在/)

  for (let index = 0; index < 21; index++) {
    const file = path.join(day, 'rollout-2026-11-19T14-00-00-extra-' + index + '.jsonl')
    await writeFile(file, rows(project, 'extra-' + index, 'Other work ' + index, 'Other reply'))
    const updated = new Date(date + 'T14:00:00Z')
    await utimes(file, updated, updated)
  }
  for (let index = 0; index < 6; index++) {
    const file = path.join(day, 'rollout-2026-11-19T15-00-00-empty-' + index + '.jsonl')
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { cwd: project, id: 'empty-' + index } }) + '\n')
    const updated = new Date(date + 'T15:00:00Z')
    await utimes(file, updated, updated)
  }

  await t.test('the title filter finds an old match outside the first 20 sessions', async () => {
    const { stdout } = await invoke(['inspect', '--query', 'SELECTED chat'])
    const matches = JSON.parse(stdout)
    assert.deepEqual(matches.conversations.map(item => item.id), [session])
    assert.equal(matches.moreConversations, false)
    assert.deepEqual(matches.memories, [])
  })

  await t.test('a burst of empty sessions does not hide the latest readable conversation', async () => {
    const { stdout } = await invoke(['handoff'])
    assert.match(stdout, /Other reply/)
  })

  await t.test('memory-only discovery finds project-specific native notes without any archived chats', async () => {
    const claude = path.join(root, 'claude')
    const slug = other.replace(/[^\p{L}\p{N}]/gu, '-')
    const native = path.join(claude, 'projects', slug, 'memory')
    await mkdir(native, { recursive: true })
    await writeFile(path.join(native, 'native-progress.md'), 'CLAUDE_PROJECT_NOTE\n')
    await writeFile(path.join(home, 'agent-bridge.json'), JSON.stringify({ agentRoots: { codex: [codex], claude: [claude] } }))
    const args = ['--project', other, '--agent', 'claude', '--no-history']
    const { stdout } = await run(process.execPath, [cli, 'inspect', ...args], { cwd: other, env })
    const inspected = JSON.parse(stdout)
    assert.deepEqual(inspected.conversations, [])
    const note = inspected.memories.find(item => item.name === 'native-progress')
    assert.ok(note)
    const { stdout: output } = await run(process.execPath, [cli, 'handoff', ...args, '--asset', note.id], { cwd: other, env })
    assert.match(output, /CLAUDE_PROJECT_NOTE/)
  })

  await t.test('project discovery offers exact paths and older conversations remain selectable', async () => {
    const { stdout } = await run(process.execPath, [cli, 'projects', '--agent', 'codex', '--query', 'WITH spaces'], { cwd: other, env })
    assert.deepEqual(JSON.parse(stdout).projects.map(item => item.cwd), [project])
    const { stdout: second } = await invoke(['inspect', '--page', '2'])
    assert.ok(JSON.parse(second).conversations.some(item => item.id === session))
  })

  await t.test('history keeps older process entries and allows explicit local attachment and Markdown export', async () => {
    const source = path.join(day, 'rollout-2026-11-19T11-00-00-old.jsonl')
    const fixture = Buffer.from('Embedded fixture attachment')
    const events = [
      { type: 'function_call', name: 'read', call_id: 'followup-read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'followup-read', output: 'Historical tool result' },
      { type: 'message', role: 'user', content: [{ type: 'input_file', file_data: fixture.toString('base64'), filename: 'fixture.txt' }] },
    ]
    await appendFile(source, events.map(payload => JSON.stringify({ type: 'response_item', payload })).join('\n') + '\n')
    const { stdout } = await invoke(['history', '--session', session])
    const history = JSON.parse(stdout)
    assert.equal(history.items.find(item => item.kind === 'tool_result').text, 'Historical tool result')
    assert.doesNotMatch(stdout, /sk-fixture|Embedded fixture attachment/)
    const attachment = history.items.find(item => item.kind === 'attachment').attachmentId
    const downloaded = path.join(project, 'download.txt')
    await invoke(['attachment', '--session', session, '--attachment', attachment, '--output', downloaded])
    assert.deepEqual(await readFile(downloaded), fixture)
    const file = path.join(project, 'source-history.md')
    await invoke(['history', '--session', session, '--format', 'share', '--include-trace', '--output', file])
    const document = await readFile(file, 'utf8')
    assert.match(document, /Selected chat[\s\S]*Historical tool result/)
    assert.doesNotMatch(document, /file:\/\/|sk-fixture/)
    await assert.rejects(invoke(['history', '--session', session, '--output', file]), /已存在/)
    assert.equal(await readFile(file, 'utf8'), document)
  })

  await t.test('Skill package review lists resources without exposing their bodies', async () => {
    const helper = path.join(project, '.claude', 'skills', 'fixture-helper')
    await mkdir(path.join(helper, 'scripts'), { recursive: true })
    await writeFile(path.join(helper, 'SKILL.md'), '---\nname: fixture-helper\ndescription: Fixture native helper\n---\n\nFIXTURE_SKILL_BODY\n')
    await writeFile(path.join(helper, 'scripts', 'run.js'), 'const resource = "FIXTURE_RESOURCE_BODY";\n')
    const { stdout: inventory } = await invoke(['inspect', '--no-history', '--include-skills', '--query', 'fixture-helper'])
    const item = JSON.parse(inventory).skills.find(item => item.name === 'fixture-helper')
    assert.ok(item)
    const { stdout: review } = await invoke(['skill-info', '--asset', item.id])
    const { files, name } = JSON.parse(review)
    assert.equal(name, 'fixture-helper')
    assert.ok(files.includes('scripts/run.js'))
    assert.doesNotMatch(review, /FIXTURE_RESOURCE_BODY/)
  })

  await t.test('project inventory respects archive state and can read a known offline source', async () => {
    const list = (...flags) => run(process.execPath, [cli, 'projects', '--agent', 'codex', ...flags], { cwd: other, env })
    await invoke(['project-state', '--operation', 'archive'])
    const { stdout: visible } = await list()
    assert.ok(!JSON.parse(visible).projects.some(item => item.cwd === project))
    const { stdout: all } = await list('--include-archived')
    assert.ok(JSON.parse(all).projects.some(item => item.cwd === project && item.archived))
    await invoke(['project-state', '--operation', 'restore'])
    const { stdout: acquired } = await list()
    assert.ok(JSON.parse(acquired).projects.some(item => item.cwd === project && !item.archived))

    const moved = path.join(root, 'moved-project')
    await rename(other, moved)
    try {
      const { stdout: offline } = await run(process.execPath, [cli, 'handoff', '--project', other, '--agent', 'codex'], { cwd: project, env })
      assert.match(offline, /Other reply/)
    } finally {
      await rename(moved, other)
    }
  })

  await t.test('history pagination stays on the selected turn and invalidates stale source cursors', async () => {
    const source = path.join(day, 'rollout-2026-11-19T11-00-00-old.jsonl')
    const append = async records => appendFile(source, records.map(payload =>
      JSON.stringify({ type: 'response_item', payload })).join('\n') + '\n')
    await append([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Pagination question' }] },
      ...Array.from({ length: 48 }, (_, index) => ({
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Result part ' + index }],
      })),
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'The next turn' }] },
    ])
    const args = ['history', '--session', session, '--turn', '3']
    const first = JSON.parse((await invoke(args)).stdout)
    assert.ok(first.nextCursor)
    const second = JSON.parse((await invoke([...args, '--cursor', first.nextCursor])).stdout)
    assert.ok(second.items.every(item => item.turn === 3))
    assert.ok(second.items.some(item => item.text === 'Result part 47'))
    assert.equal(second.nextCursor, null)
    await append([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'New data' }] }])
    await assert.rejects(invoke([...args, '--cursor', first.nextCursor]), /分页位置已变化/)
  })
})
