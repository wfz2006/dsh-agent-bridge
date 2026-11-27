import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const parent = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, '.local', 'skill-dist')
const output = path.join(parent, 'agent-bridge')
const runtime = path.join(output, 'scripts', 'runtime')
const core = [
  'src/assets.js',
  'src/config.js',
  'src/conversation-readers.js',
  'src/conversation-store.js',
  'src/export.js',
  'src/handoff.js',
  'src/history-attachment.js',
  'src/project-archive.js',
  'src/projects.js',
  'src/session-trace.js',
  'src/skill-cli.js',
  'src/skill-history.js',
  'src/skill-output.js',
  'src/skill-package.js',
  'web/markdown.js',
  'web/share-redaction.js',
  'web/vendor/markdown-it.mjs',
  'web/vendor/markdown-it-LICENSE.txt',
]

await mkdir(parent, { recursive: true })
try {
  await mkdir(output)
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  process.stderr.write('技能包目标已存在，请指定一个新的输出父目录。\n')
  process.exit(1)
}
await mkdir(path.join(runtime, 'src'), { recursive: true })
await mkdir(path.join(runtime, 'web', 'vendor'), { recursive: true })
await mkdir(path.join(output, 'references'))
await Promise.all([
  copyFile(path.join(root, 'skills', 'agent-bridge', 'SKILL.md'), path.join(output, 'SKILL.md')),
  copyFile(path.join(root, 'skills', 'agent-bridge', 'references', 'commands.md'), path.join(output, 'references', 'commands.md')),
  writeFile(path.join(output, 'THIRD_PARTY_NOTICES.md'),
    '# Third-party notices\n\nThis standalone Skill bundles markdown-it. See the [upstream and dependency licenses](scripts/runtime/web/vendor/markdown-it-LICENSE.txt).\n'),
  writeFile(path.join(runtime, 'package.json'), '{ "private": true, "type": "module" }\n'),
  ...core.map(file => copyFile(path.join(root, file), path.join(runtime, file))),
])
console.log(output)
