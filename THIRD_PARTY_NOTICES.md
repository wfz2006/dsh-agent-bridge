# Third-party notices

Agent Bridge includes small, adapted portions of the following MIT-licensed
projects. The adapted code is limited to skill package enumeration, stable
content fingerprints, safe copying, and isolated provider wiring.

The independent Markdown preview also bundles the upstream `markdown-it`
15.0.3 browser ESM distribution. Its license and the bundled dependency
licenses are in `web/vendor/markdown-it-LICENSE.txt`.

## dsh-mode-skills

- Source: <https://github.com/xiaohai-78/dsh-mode-skills>
- Revision: `706595127984c9bc87627f77d2a8e288b8dcbbbb`
- Used for: package file limits, frontmatter parsing, link containment,
  fingerprints, and copy verification in `src/skill-package.js`.

MIT License

Copyright (c) 2026 xiaohai-78

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## dsh-skill-import

- Source: <https://github.com/Trank-DTK/dsh-skill-import>
- Revision: `68b56106e232aa15e206483d184150b144c13180`
- Used for: the isolated `FileSystemSkillProvider` registration pattern that
  lets a plugin supply skills from its own DSH-private directory.

MIT License

Copyright (c) 2026 dsh-skill-import contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
