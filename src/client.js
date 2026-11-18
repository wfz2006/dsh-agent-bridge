window.__ModuleLoader__.load({
  id: '@wwwfz/dsh-agent-bridge',
  factory: (require) => {
    const { createElement: h, useCallback, useEffect, useRef, useState } = require('react');
    const { createPortal } = require('react-dom');
    const panelId = 'dsh-agent-bridge';
    const messages = {
      zh: {
        title: 'Agent 工作接续',
        trace: '来源记录',
        traceTitle: '来源记录',
        traceExcerpt: '工具记录摘录',
        inlineProcess: '历史过程',
        inlineCalls: '{count} 次工具调用',
        inlineSourceTurn: '来源第 {turn} 轮',
        archiveExport: '导出来源全文',
        traceEmpty: '没有为这条会话保存来源记录。',
        traceFailed: '暂时无法读取来源记录。',
        traceClose: '关闭',
        traceCopy: '复制结果摘录',
        traceCopied: '已复制',
        traceTurn: '第 {turn} 轮',
        traceUnnumbered: '未标记轮次',
        traceOneItem: '1 项',
        traceItemCount: '{count} 项',
        traceCall: '调用',
        statsTitle: '原对话统计',
        statsOverview: '{turns} 轮 · {messages} 条消息',
        statsTurns: '已读轮次',
        statsMessages: '已读消息',
        statsTools: '已保存工具调用',
        statsSpan: '消息时间跨度',
        statsTokens: '源记录 Token',
        statsRoles: '用户 {user} 条，助手 {assistant} 条',
        statsImported: '已迁入 {count} 条消息',
        statsFailed: '{count} 次失败',
        statsMissing: '{count} 次未记录结果',
        statsSummaries: '{count} 段思考摘要',
        statsTokenDetail: '输入 {input}，输出 {output}',
        statsPartial: '消息与轮次仅统计已读取的部分原记录。',
        statsLegacy: '旧版迁入的会话，统计来自当时保存的来源记录。',
        archiveTitle: '完整历史',
        archiveIndex: '回合目录',
        archiveDetails: '会话详情',
        archiveDetailsShort: '详情',
        archiveJump: '跳转',
        archiveRead: '阅读对话',
        archiveContinued: '接上页',
        archiveMore: '本轮在下一页继续',
        archiveMissingTurn: '找不到这一轮，可以输入其他轮次。',
        archiveUnclear: '部分记录缺失',
        archiveFiles: '{count} 个附件',
        archiveLoading: '正在读取…',
        archiveFirst: '最早一页',
        archivePrevious: '上一页',
        archiveNext: '下一页',
        archivePage: '第 {page} 页',
        archiveGo: '跳到回合',
        archiveRound: '回合号',
        archiveRetry: '重试',
        archiveEmpty: '这页暂无来源记录。',
        archivePartial: '有部分来源内容无法读取，详情见记录。',
        archiveScope: '{messages} 条历史消息 · {tools} 条工具记录 · {attachments} 个附件 · 已迁入 {native} 条消息',
        archiveNativeRange: '（原第 {turns} 轮）',
        archiveContext: ' · 续聊上下文 {count} 条',
        archiveWithTools: '附带工具和摘要',
        archiveLocal: '下载来源全文（本机版）',
        archiveShare: '下载来源全文（分享版）',
        archiveAttachment: '附件',
        archiveImageZoomIn: '放大图片',
        archiveImageZoomOut: '缩小图片',
        archiveImageUnavailable: '暂时无法显示缩略图，可下载原文件。',
        archiveProcess: '过程',
        archivePageItemCount: '本页 {count} 项',
        archiveUser: '用户',
        archiveAssistant: '助手',
        archiveQuote: '引用到草稿',
        archiveQuoted: '已填入草稿。',
        archiveCopy: '复制摘录',
        archiveSegment: '分段显示',
        archiveBranch: '分支 {id}',
      },
      en: {
        title: 'Agent Workspace Handoff',
        trace: 'Source record',
        traceTitle: 'Source record',
        traceExcerpt: 'Tool record excerpts',
        inlineProcess: 'Imported process',
        inlineCalls: '{count} tool calls',
        inlineSourceTurn: 'Source turn {turn}',
        archiveExport: 'Export full history',
        traceEmpty: 'No source record is saved for this session.',
        traceFailed: 'The source record cannot be read right now.',
        traceClose: 'Close',
        traceCopy: 'Copy result excerpt',
        traceCopied: 'Copied',
        traceTurn: 'Turn {turn}',
        traceUnnumbered: 'Unnumbered records',
        traceOneItem: '1 item',
        traceItemCount: '{count} items',
        traceCall: 'Call',
        statsTitle: 'Original conversation statistics',
        statsOverview: '{turns} turns · {messages} messages',
        statsTurns: 'Turns read',
        statsMessages: 'Messages read',
        statsTools: 'Saved tool calls',
        statsSpan: 'Message time span',
        statsTokens: 'Source tokens',
        statsRoles: '{user} user and {assistant} assistant messages',
        statsImported: '{count} messages imported',
        statsFailed: 'Failed calls: {count}',
        statsMissing: 'Calls with no recorded result: {count}',
        statsSummaries: 'Reasoning summaries: {count}',
        statsTokenDetail: 'Input {input}, output {output}',
        statsPartial: 'The message and turn counts cover the part of the source that was read.',
        statsLegacy: 'Statistics for this older import come from its saved source records.',
        archiveTitle: 'Full history',
        archiveIndex: 'Turn index',
        archiveDetails: 'Session details',
        archiveDetailsShort: 'Details',
        archiveJump: 'Jump',
        archiveRead: 'Read conversation',
        archiveContinued: 'Continued',
        archiveMore: 'Continue this turn on the next page',
        archiveMissingTurn: 'This turn was not found. Try a different turn number.',
        archiveUnclear: 'Partial record',
        archiveFiles: '{count} attachments',
        archiveLoading: 'Loading…',
        archiveFirst: 'First page',
        archivePrevious: 'Previous page',
        archiveNext: 'Next page',
        archivePage: 'Page {page}',
        archiveGo: 'Go to turn',
        archiveRound: 'Turn number',
        archiveRetry: 'Retry',
        archiveEmpty: 'There are no records on this page.',
        archivePartial: 'Part of the source is unavailable. See the records for details.',
        archiveScope: '{messages} history messages · {tools} tool records · {attachments} attachments · {native} messages imported',
        archiveNativeRange: ' (source turns {turns})',
        archiveContext: ' · {count} messages in continuation context',
        archiveWithTools: 'Include tools and summaries',
        archiveLocal: 'Download full history (local)',
        archiveShare: 'Download full history (shareable)',
        archiveAttachment: 'Attachment',
        archiveImageZoomIn: 'Enlarge image',
        archiveImageZoomOut: 'Shrink image',
        archiveImageUnavailable: 'The thumbnail is unavailable. You can download the original.',
        archiveProcess: 'Process',
        archivePageItemCount: '{count} on this page',
        archiveUser: 'User',
        archiveAssistant: 'Assistant',
        archiveQuote: 'Quote in draft',
        archiveQuoted: 'Added to draft.',
        archiveCopy: 'Copy excerpt',
        archiveSegment: 'Shown in parts',
        archiveBranch: 'Branch {id}',
      },
    };

    function validPath(value) {
      return typeof value === 'string' && value.length > 0 && value.length <= 4096
        && !/[\u0000-\u001f]/u.test(value);
    }

    function pathKey(path) {
      if (/^[a-z]:[\\/]|^\\\\|^\/\//i.test(path)) {
        return path.replace(/\//g, '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\')
          .replace(/^\\\\\?\\/, '').replace(/\\+$/, '').toLowerCase();
      }
      return path.replace(/\/+$/, '');
    }

    function sessionRow(summary) {
      if (!summary || summary.blank || summary.origin === 'subagent' || !validPath(summary.cwd)) return;
      return {
        id: summary.id,
        title: (summary.title || summary.displayTitle || '未命名会话').slice(0, 240),
        path: summary.cwd,
        updatedAt: summary.updatedAt,
      };
    }

    function dialogueFrom(event) {
      if (event?.surfaceOp !== 'append') return;
      let content;
      let role;
      if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
        role = 'user';
        content = event.data.content;
      } else if (event.type === 'assistant/message') {
        role = 'assistant';
        content = event.data?.message?.content;
      }
      if (!Array.isArray(content)) return;
      const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text).join('\n\n');
      return text.trim() ? { role, text } : undefined;
    }

    async function sessionDialogue(remote, sessionId, signal) {
      const collected = [];
      const address = { kind: 'session', sessionId };
      let remaining = 28_000;
      let throughSeq;
      let beforeSeq;
      let hasMore = true;
      let truncated = false;
      for (let page = 0; page < 8 && hasMore && !truncated; page++) {
        const result = await remote.events({ address, maxMessages: 40,
          ...(throughSeq === undefined ? {} : { throughSeq, beforeSeq }),
        }, signal);
        if (!result.ok) throw new Error('无法读取这条 DSH 会话的历史。');
        const { records, cursor } = result.value;
        hasMore = result.value.hasMore;
        throughSeq ??= cursor;
        for (let i = records.length - 1; i >= 0; i--) {
          const message = dialogueFrom(records[i].event);
          if (!message) continue;
          if (collected.length >= 24 || message.text.length > remaining) {
            if (!collected.length) collected.push({ ...message,
              text: message.text.slice(0, remaining).replace(/[\uD800-\uDBFF]$/, ''),
            });
            truncated = true;
            break;
          }
          collected.push(message);
          remaining -= message.text.length;
        }
        const firstSeq = records[0]?.event?.seq;
        if (hasMore && (!Number.isSafeInteger(firstSeq) || firstSeq <= 0 || firstSeq >= (beforeSeq ?? Infinity))) break;
        beforeSeq = firstSeq;
      }
      return { messages: collected.reverse(), truncated: truncated || hasMore };
    }

    function PanelIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, h('path', { d: 'M3 17.5V6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z M8 13h8m-3-3 3 3-3 3' }));
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(panelId, messages), 'agent bridge locale');
      const t = ctx.locale.bind(panelId);
      const recentImports = new Map();
      const incompleteDrafts = new Map();
      let importing = false;

      async function exportRequest(request, signal) {
        if (request.path !== undefined && !validPath(request.path)) throw new Error('工作目录格式无效。');
        const scope = request.path === undefined ? undefined : pathKey(request.path);
        const snapshot = ctx.sessions.list.getSnapshot();
        if (snapshot.phase !== 'ready') throw new Error('DSH 会话列表正在加载，请稍后重试。');
        const rows = snapshot.ids.map(id => sessionRow(snapshot.byId[id]))
          .filter(row => row && (scope === undefined || pathKey(row.path) === scope));
        if (request.type === 'dsh-agent-bridge:sessions') return { sessions: rows };

        const selected = rows.find(row => row.id === request.sessionId);
        if (!selected) throw new Error('未在这个工作区找到可导出的 DSH 会话。');
        const dialogue = await sessionDialogue(ctx.remote.session, selected.id, signal);
        if (!dialogue.messages.length) throw new Error('这条 DSH 会话暂无可导出的文字。');
        return { conversation: { title: selected.title, path: selected.path, ...dialogue } };
      }

      function rememberImport(requestId, imported) {
        if (!recentImports.has(requestId) && recentImports.size >= 32) {
          recentImports.delete(recentImports.keys().next().value);
        }
        recentImports.set(requestId, imported);
      }

      async function rollbackDraft(imported, binding) {
        try {
          const session = binding?.session;
          const state = session?.getSnapshot();
          const input = binding && ctx.conversation.input.for(binding.ctx).snapshot;
          // A preserved draft, attachments, or a chat already in use belong to
          // the user. Archive only an unused, empty chat created by this handoff.
          if (state && (!state.blank || state.running || state.promptAttempted || state.removed)) return false;
          if (binding && (!input || input.draft !== '' || input.attachmentIds?.length
            || ['adjudicating', 'submitting', 'sending'].includes(input.phase))) return false;
          await ctx.workspaces.archiveSession(imported.sessionId);
          incompleteDrafts.delete(imported.path);
          for (const [key, item] of recentImports) if (item === imported) recentImports.delete(key);
          return true;
        } catch {
          return false;
        }
      }

      async function prepareSession(request, reveal) {
        const path = pathKey(request.path);
        let imported = recentImports.get(request.requestId) ?? incompleteDrafts.get(path);
        if (imported && imported.path !== path) throw new Error('交接工作目录已变化，请重新预览。');
        if (!imported) {
          const workspace = await ctx.workspaces.create({ path: request.path });
          const sessionId = await ctx.sessions.create({ workspaceId: workspace.workspaceId });
          imported = { sessionId, path, ready: false };
          incompleteDrafts.set(path, imported);
        }
        rememberImport(request.requestId, imported);

        let reference;
        try {
          if (!imported.ready) {
            let binding;
            let outcome;
            try {
              reference = ctx.sessions.retain(imported.sessionId, { source: panelId });
              binding = reference.binding;
              await reference.ready;
              outcome = ctx.conversation.input.requestDraftInitialization(binding, {
                prompt: request.prompt,
                whenDraftExists: 'keep',
              });
            } catch {
              // A Host error can also leave an empty session to roll back.
            }
            if (outcome !== 'applied') {
              if (outcome !== 'preserved' && await rollbackDraft(imported, binding)) {
                throw new Error('DSH 未能填入交接草稿。空白会话已归档，可重试。');
              }
              throw new Error(outcome === 'preserved'
                ? '会话中已有草稿，已原样保留。可打开会话并手动补入交接资料。'
                : 'DSH 未能填入交接草稿。可重试同一会话，或打开后手动补入交接资料。');
            }
            imported.ready = true;
            incompleteDrafts.delete(path);
          }
          reveal(imported.sessionId);
          return imported.sessionId;
        } finally {
          reference?.release();
        }
      }

      async function quoteHistory(sessionId, text) {
        if (typeof text !== 'string' || !text.trim() || text.length > 65_536 || /\0/u.test(text)) {
          throw new Error('摘录为空或过长，请选择一段文字复制。');
        }
        const snapshot = ctx.sessions.list.getSnapshot();
        if (snapshot.phase !== 'ready' || !Object.hasOwn(snapshot.byId, sessionId) || !sessionRow(snapshot.byId[sessionId])) {
          throw new Error('找不到可以引用来源历史的 DSH 会话。');
        }
        const reference = ctx.sessions.retain(sessionId, { source: panelId });
        try {
          await reference.ready;
          const prompt = text.split(/\r?\n/u).map(line => `> ${line}`).join('\n') + '\n\n';
          const outcome = ctx.conversation.input.requestDraftInitialization(reference.binding, { prompt, whenDraftExists: 'append' });
          if (outcome === 'preserved') throw new Error('已有草稿，已保留。可复制摘录后手动粘贴。');
          if (outcome !== 'applied') throw new Error('无法填入草稿。可复制摘录后手动粘贴。');
        } finally {
          reference.release();
        }
      }

      const traceKind = { summary: '思考摘要', tool_call: '工具调用', tool_result: '工具结果', turn_end: '回合结束' };
      const traceState = {
        missing: '未记录结果', error: '失败', pending: '未完成', truncated: '已截取', unmatched: '归属未知', incomplete: '未完成',
        completed: '已完成', interrupted: '已中断',
      };
      const number = new Intl.NumberFormat().format;

      function formatSpan(milliseconds) {
        const seconds = Math.floor(milliseconds / 1000);
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor(seconds / 60) % 60;
        const rest = String(seconds % 60).padStart(2, '0');
        return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
      }

      function SourceStats({ stats, counts = {}, t }) {
        const values = [];
        const notes = [];
        if (stats) {
          const total = stats.userMessages + stats.assistantMessages;
          values.push(['statsTurns', number(stats.userMessages)], ['statsMessages', number(total)]);
          notes.push(t('statsRoles').replace('{user}', number(stats.userMessages)).replace('{assistant}', number(stats.assistantMessages)));
          if (stats.importedMessages !== total) notes.push(t('statsImported').replace('{count}', number(stats.importedMessages)));
        }
        values.push(['statsTools', number(counts.toolCall ?? 0)]);
        if (stats?.elapsedMs !== undefined) values.push(['statsSpan', formatSpan(stats.elapsedMs)]);
        if (stats?.tokens) {
          values.push(['statsTokens', number(stats.tokens.total)]);
          const { input, output } = stats.tokens;
          if (input !== undefined && output !== undefined) {
            notes.push(t('statsTokenDetail').replace('{input}', number(input)).replace('{output}', number(output)));
          }
        }
        for (const [count, label] of [[counts.failed, 'statsFailed'], [counts.missing, 'statsMissing'], [counts.summary, 'statsSummaries']]) {
          if (count) notes.push(t(label).replace('{count}', number(count)));
        }
        const scope = stats ? (stats.partial ? t('statsPartial') : '') : t('statsLegacy');
        return h('details', { className: 'bridge-reader bridge-stats', open: !stats }, [
          h('summary', { key: 'title', className: 'reader-summary' }, [
            t('statsTitle'),
            stats && h('small', { key: 'overview' }, t('statsOverview').replace('{turns}', number(stats.userMessages))
              .replace('{messages}', number(stats.userMessages + stats.assistantMessages))),
          ]),
          h('dl', { key: 'values' }, values.map(([label, value]) => h('div', { key: label }, [
            h('dt', { key: 'label' }, t(label)),
            h('dd', { key: 'value' }, value),
          ]))),
          notes.length ? h('p', { key: 'notes' }, notes.join(' · ')) : null,
          scope ? h('p', { key: 'scope' }, scope) : null,
        ]);
      }

      function archiveUrl(route, sessionId, values = {}) {
        const url = new URL(`agent-bridge/${route}`, document.baseURI);
        url.search = new URLSearchParams({ sessionId, ...values }).toString();
        return url.href;
      }

      const processIndexes = new Map();
      function processIndex(sessionId) {
        const cached = processIndexes.get(sessionId);
        if (cached && cached.expires > Date.now()) return cached.request;
        const request = fetch(archiveUrl('conversation-process', sessionId))
          .then(response => {
            if (response.status === 404) return { placements: [] };
            if (!response.ok) throw new Error('Could not read imported process index');
            return response.json();
          });
        request.catch(() => {
          if (processIndexes.get(sessionId)?.request === request) processIndexes.delete(sessionId);
        });
        processIndexes.delete(sessionId);
        processIndexes.set(sessionId, { request, expires: Date.now() + 60_000 });
        if (processIndexes.size > 8) processIndexes.delete(processIndexes.keys().next().value);
        return request;
      }

      const inlineProcessNode = 'agent-bridge-source-process';
      const inlineProcessDefinition = {
        kind: inlineProcessNode,
        target: 'chat',
        match: {
          'assistant/message': event => event.surfaceOp === 'append' && event.data.message?.source?.provider === 'agent-bridge-import'
            ? { id: String(event.seq), role: 'start' } : null,
        },
        start: (_context, match) => match.event.seq,
        update: context => context.state,
        buildViewNode(context) {
          const location = context.start?.location;
          if (!location || (location.kind !== 'step' && location.kind !== 'turn')) return null;
          return {
            key: context.key, id: context.id, kind: inlineProcessNode, target: 'chat',
            anchorSeq: context.state - 0.25, location, groupTree: 'turn', visibility: 'visible',
            data: { anchor: context.state, turn: location.turn },
          };
        },
      };

      function InlineProcessNode({ sessionId, node, t }) {
        return h(InlineProcess, { sessionId, ...node.data, t });
      }

      function InlineProcessTail({ sessionId, turn, t }) {
        return h(InlineProcess, { sessionId, turn, anchor: turn.end?.seq, tail: true, t });
      }

      function InlineProcess({ sessionId, turn, anchor, tail = false, t }) {
        const [index, setIndex] = useState();
        useEffect(() => {
          if (!sessionId) return undefined;
          let mounted = true;
          processIndex(sessionId).then(value => {
            if (mounted) setIndex({ sessionId, placements: value.placements });
          }, () => {});
          return () => { mounted = false; };
        }, [sessionId]);
        const entry = index?.sessionId === sessionId ? index.placements.find(item =>
          item.nativeTurn === turn.turn && item.anchor === anchor && item.tail === tail
            && (turn.start ? item.start === turn.start.seq : !tail)) : undefined;
        return entry ? h(InlineProcessDetails, { key: sessionId + ':' + entry.anchor, sessionId, entry, t }) : null;
      }

      function InlineProcessDetails({ sessionId, entry, t }) {
        const [open, setOpen] = useState(false);
        const [locations, setLocations] = useState([null]);
        const [result, setResult] = useState();
        const [attempt, retry] = useState(0);
        const cursor = locations.at(-1);
        useEffect(() => {
          if (!open) return undefined;
          const controller = new AbortController();
          const values = { turn: entry.sourceTurn, after: entry.after,
            ...(entry.before === undefined ? {} : { before: entry.before }), ...(cursor ? { cursor } : {}) };
          setResult(undefined);
          fetch(archiveUrl('conversation-process', sessionId, values), { signal: controller.signal })
            .then(response => {
              if (!response.ok) throw new Error('Could not read imported process');
              return response.json();
            })
            .then(page => { if (!controller.signal.aborted) setResult({ cursor, page }); })
            .catch(() => { if (!controller.signal.aborted) setResult({ cursor, failed: true }); });
          return () => controller.abort();
        }, [open, sessionId, entry.sourceTurn, entry.after, entry.before, cursor, attempt]);

        const current = result?.cursor === cursor ? result : undefined;
        const button = (key, label, onClick) => h('button', { key, type: 'button', onClick }, t(label));
        const count = t(entry.calls ? 'inlineCalls' : 'traceItemCount').replace('{count}', number(entry.calls || entry.count));
        const summary = [t('inlineProcess'), count,
          t('inlineSourceTurn').replace('{turn}', number(entry.sourceTurn))].join(' · ');
        return h('details', { className: 'bridge-inline-process',
          onToggle: event => setOpen(event.currentTarget.open) }, [
          h('summary', { key: 'summary' }, summary),
          open && h('div', { key: 'body' }, [
            !current && h('p', { key: 'loading', role: 'status' }, t('archiveLoading')),
            current?.failed && h('div', { key: 'error', role: 'status' }, [
              t('traceFailed'), ' ', button('retry', 'archiveRetry', () => retry(value => value + 1)),
            ]),
            ...((current?.page?.items ?? []).map(item => h('article', {
              key: item.seq + ':' + (item.offset ?? 0),
            }, [
              h('strong', { key: 'label' }, [
                traceKind[item.kind], item.name, item.callId ? t('traceCall') + ' ' + item.callId : '',
                traceState[item.status], item.branchId ? t('archiveBranch').replace('{id}', item.branchId) : '',
                item.offset || item.continued ? t('archiveSegment') : '',
              ].filter(Boolean).join(' · ')),
              h('pre', { key: 'text', tabIndex: 0 }, item.text || t('traceEmpty')),
            ]))),
            current?.page && (locations.length > 1 || current.page.nextCursor) ? h('nav', {
              key: 'pages', 'aria-label': t('inlineProcess'),
            }, [
              locations.length > 1 && button('previous', 'archivePrevious', () => setLocations(values => values.slice(0, -1))),
              ' ', t('archivePage').replace('{page}', number(locations.length)), ' ',
              current.page.nextCursor && button('next', 'archiveNext',
                () => setLocations(values => [...values, current.page.nextCursor])),
            ]) : null,
          ]),
        ]);
      }

      const archiveIssues = new Map([
        ['source-unavailable', '找不到会话来源。'],
        ['source-unreadable', '无法读取部分来源记录。'],
        ['source-mismatch', '来源的工作目录和项目不一致。'],
        ['source-metadata-missing', '来源缺少用于核对会话身份的记录。'],
        ['source-compacted', '来源已压缩早期历史，原文可能已不在源记录中。'],
        ['source-dialogue-only', '来源只有已保存的问答，工具和附件记录可能缺失。'],
        ['source-tool-output-truncated', '源记录中的工具输出已被截取。'],
        ['archive-tool-details-unavailable', '归档缺少工具调用详情。'],
        ['unresolved-branch', '无法确定部分分支的归属。'],
        ['unresolved-source-projection', '有部分来源消息无法核对。'],
        ['unsupported-source-schema', '当前版本不识别这份来源的存储结构。'],
        ['unsupported-incremental-edit', '部分增量编辑无法恢复。'],
        ['unsupported-source', '当前版本无法读取这类来源。'],
        ['unsupported-compression', '当前 DSH 无法解压这份日志。'],
        ['malformed-record', '有一条来源记录损坏或格式无法识别。'],
        ['record-too-large', '有一条来源记录超过可读取的大小。'],
        ['corrupt-compressed-source', '压缩日志不完整或已损坏。'],
        ['source-changed', '读取期间，来源发生变化。'],
        ['remote-reference', '此附件只有远程引用。'],
        ['name-only', '来源只保存了附件名称。'],
        ['outside-project', '附件不在可读取范围内。'],
        ['attachment-unavailable', '附件已移动或无法访问。'],
        ['attachment-too-large', '附件超过可保存的大小。'],
      ]);

      const readerPaths = {
        book: 'M3 5.5c3-1.4 6-1.1 9 1 3-2.1 6-2.4 9-1v13c-3-1.4-6-1.1-9 1-3-2.1-6-2.4-9-1z M12 6.5v13',
        file: 'M6 3.5h8l4 4v13H6z M14 3.5v5h4 M9 13h6 M9 16h4',
        copy: 'M9 8h11v13H9z M15 8V3H4v13h5',
        quote: 'M5 10h14v3a5 5 0 0 1-5 5H9 M9 6l-4 4 4 4',
        back: 'M14.5 5.5 8 12l6.5 6.5',
        next: 'm9.5 5.5 6.5 6.5-6.5 6.5',
        close: 'm6 6 12 12 M18 6 6 18',
        settings: 'M4 7h7m4 0h5M4 17h3m4 0h9 M11 4v6 M7 14v6',
      };
      function readerIcon(name) {
        return h('svg', { key: name, viewBox: '0 0 24 24', width: 17, height: 17, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('path', { d: readerPaths[name] }));
      }

      function hasThumbnail(item) {
        return item.status === 'saved' && item.attachmentId && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.mediaType);
      }

      function HistoryAttachment({ item, sessionId, t }) {
        const [imageFailed, setImageFailed] = useState(false);
        const [enlarged, setEnlarged] = useState(false);
        const name = item.name || t('archiveAttachment');
        if (item.status !== 'saved' || !item.attachmentId) {
          return h('div', { className: 'archive-attachment record-file unavailable' }, [
            readerIcon('file'), h('strong', { key: 'name', className: 'archive-attachment-name' }, name),
            h('p', { key: 'state', className: 'reader-body' }, archiveIssues.get(item.reason || item.status) || t('archivePartial')),
          ]);
        }
        const url = archiveUrl('conversation-attachment', sessionId, {
          attachmentId: item.attachmentId,
          ...(Number.isSafeInteger(item.seq) ? { seq: item.seq } : {}),
        });
        const isImage = hasThumbnail(item);
        const inlineUrl = url + '&inline=true';
        return h('div', { className: isImage && !imageFailed ? 'archive-attachment record-image' : 'archive-attachment record-file' }, [
          (!isImage || imageFailed) && readerIcon('file'),
          isImage && !imageFailed ? h('button', {
            key: 'preview', type: 'button', 'aria-pressed': enlarged,
            'aria-label': `${t(enlarged ? 'archiveImageZoomOut' : 'archiveImageZoomIn')} ${name}`,
            onClick: () => setEnlarged(value => !value),
            className: 'archive-attachment-preview',
          }, h('img', {
            src: inlineUrl, alt: name, loading: 'lazy', decoding: 'async',
            onError: () => setImageFailed(true),
          })) : null,
          isImage && imageFailed ? h('p', { key: 'error', className: 'reader-body' }, t('archiveImageUnavailable')) : null,
          h('a', {
            key: 'download', className: 'archive-attachment-name',
            href: url, download: name,
          }, name),
        ]);
      }

      function pageTurns(items) {
        const turns = new Map();
        for (const [index, item] of items.entries()) {
          const id = item.turn || 0;
          if (!turns.has(id)) turns.set(id, { id, rows: [], processes: new Map(), title: '' });
          const turn = turns.get(id);
          if (!turn.title && item.kind === 'message' && item.role === 'user') {
            turn.title = (item.text || '').trim().slice(0, 100).replace(/\s+/gu, ' ');
          }
          if (['summary', 'tool_call', 'tool_result'].includes(item.kind)) {
            const branch = item.branchId || '';
            if (!turn.processes.has(branch)) {
              const group = { process: true, branch, index, items: [], ids: new Set() };
              turn.processes.set(branch, group);
              turn.rows.push(group);
            }
            const group = turn.processes.get(branch);
            group.items.push({ item, index });
            group.ids.add(item.seq ?? index);
          } else if (item.kind === 'attachment') {
            let group = turn.rows.at(-1);
            if (!group?.files || item.branchId !== group.branch) {
              group = { index, branch: item.branchId, files: [] };
              turn.rows.push(group);
            }
            group.files.push({ item, index });
          } else {
            turn.rows.push({ item, index });
          }
        }
        return [...turns.values()];
      }

      function ArchiveDetails({ history, sessionId, t }) {
        const [includeTrace, setIncludeTrace] = useState(false);
        const { nativeFirstTurn: start, nativeLastTurn: end } = history;
        const range = start && end ? t('archiveNativeRange').replace('{turns}', start === end ? start : start + '–' + end) : '';
        const scope = t('archiveScope').replace('{messages}', number(history.messages ?? 0))
          .replace('{tools}', number(history.tools ?? 0)).replace('{attachments}', number(history.attachments ?? 0))
          .replace('{native}', number(history.nativeMessages ?? 0)) + range
          + (history.nativeTimeline ? t('archiveContext').replace('{count}', number(history.contextMessages)) : '');
        return h('section', { className: 'record-export' }, [
          h('h3', { key: 'title' }, t('archiveExport')),
          h('p', { key: 'info', className: 'reader-note' }, scope),
          history.complete === false && h('p', { key: 'partial', className: 'reader-note' }, t('archivePartial')),
          h('div', { key: 'links', className: 'reader-downloads' }, [
            ...[['local', 'archiveLocal'], ['share', 'archiveShare']].map(([format, label]) =>
              h('a', { key: format, className: 'reader-button', download: '', href: archiveUrl('conversation-export', sessionId, {
                format, includeTrace: String(includeTrace),
              }) }, t(label))),
            h('label', { key: 'tools' }, [
              h('input', { key: 'check', type: 'checkbox', checked: includeTrace,
                onChange: event => setIncludeTrace(event.target.checked) }), ' ', t('archiveWithTools'),
            ]),
          ]),
        ]);
      }

      function SourceArchive({ sessionId, t, hidden }) {
        const [selected, setSelected] = useState(null);
        const [locations, setLocations] = useState([{}]);
        const [response, setResponse] = useState();
        const [attempt, setAttempt] = useState(0);
        const [notice, setNotice] = useState('');
        const [quoting, setQuoting] = useState(false);
        const records = useRef(null);
        const locator = locations.at(-1);
        useEffect(() => {
          const request = new AbortController();
          const url = archiveUrl('conversation-history', sessionId, locator);
          setResponse(undefined);
          setNotice('');
          fetch(url, { signal: request.signal, headers: { Accept: 'application/json' } })
            .then(async result => {
              if (!result.ok) throw new Error(t('traceFailed'));
              return result.json();
            })
            .then(page => { if (!request.signal.aborted) setResponse({ locator, page }); })
            .catch(() => { if (!request.signal.aborted) setResponse({ locator, failed: true }); });
          return () => request.abort();
        }, [sessionId, locator, attempt]);

        const current = response?.locator === locator ? response : undefined;
        const page = current?.page;
        const turns = pageTurns(page?.items || []);
        const active = turns.find(turn => turn.id === selected) || turns.find(turn => turn.id > 0) || turns[0];
        const round = id => id ? t('traceTurn').replace('{turn}', number(id)) : t('traceUnnumbered');
        function move(values) {
          setSelected(null);
          setLocations(values);
        }
        useEffect(() => {
          if (records.current) records.current.scrollTop = 0;
          setNotice('');
        }, [active?.id, locator]);
        const button = (key, label, onClick, disabled, icon) => h('button', {
          key, type: 'button', className: icon ? 'record-icon' : 'reader-button',
          'aria-label': t(label), title: t(label), onClick, disabled,
        }, icon ? readerIcon(icon) : t(label));
        const turnTitle = active && [round(active.id), active.id === page.continuedTurn ? t('archiveContinued') : ''].filter(Boolean).join(' · ');
        const renderItem = (item, index, prefix) => {
          const title = item.kind === 'message'
            ? t(item.role === 'user' ? 'archiveUser' : 'archiveAssistant')
            : (traceKind[item.kind] ?? t('archiveAttachment'));
          const detail = [
            item.kind === 'attachment' ? '' : item.name,
            item.callId ? `${t('traceCall')} ${item.callId}` : '', traceState[item.status],
            item.offset || item.continued ? t('archiveSegment') : '',
            item.branchId ? t('archiveBranch').replace('{id}', item.branchId) : '',
          ].filter(Boolean).join(' · ');
          return h('article', { key: index, className: 'turn-entry',
            'data-role': item.role }, item.kind === 'gap'
            ? h('p', { className: 'reader-body' }, archiveIssues.get(item.reason) || t('archivePartial'))
            : [
              h(prefix ? 'h3' : 'strong', { key: 'label', className: 'entry-label' }, prefix ? prefix + ' · ' + title : title),
              detail && h('small', { key: 'detail', className: 'reader-detail' }, detail),
              item.text ? h('p', { key: 'text', className: item.role === 'user' && item.text.length < 115 && !item.offset && !item.continued ? 'reader-body turn-question' : 'reader-body' }, item.text) : null,
              item.text ? h('div', { key: 'actions', className: 'reader-actions' }, [
                button('copy', 'archiveCopy', async () => {
                  try {
                    await navigator.clipboard.writeText(item.text);
                    setNotice(t('traceCopied'));
                  } catch {
                    setNotice('无法写入剪贴板，请手动选择文本。');
                  }
                }, false, 'copy'),
                item.text.length <= 65_536 ? button('quote', 'archiveQuote', async () => {
                  setQuoting(true);
                  try {
                    await quoteHistory(sessionId, item.text);
                    setNotice(t('archiveQuoted'));
                  } catch (error) {
                    setNotice(error.message);
                  } finally {
                    setQuoting(false);
                  }
                }, quoting, 'quote') : null,
              ]) : null,
            ]);
        };
        function renderRow(row, position) {
          if (row.item) return renderItem(row.item, row.index, position === 0 && row.item.kind === 'message' ? turnTitle : undefined);
          const branch = row.branch ? t('archiveBranch').replace('{id}', row.branch) : '';
          if (row.files) {
            const images = [], documents = [];
            for (const { item, index } of row.files) {
              const list = hasThumbnail(item) ? images : documents;
              list.push(h(HistoryAttachment, { key: index, item, sessionId, t }));
            }
            return h('section', { key: row.index, className: 'turn-files' }, [
              h('h4', { key: 'heading' }, [t('archiveFiles').replace('{count}', row.files.length), branch].filter(Boolean).join(' · ')),
              h('div', { key: 'files', className: 'file-gallery' }, [
                images.length ? h('div', { key: 'images', className: 'file-images' }, images) : null,
                documents.length ? h('div', { key: 'documents', className: 'file-documents' }, documents) : null,
              ]),
            ]);
          }
          const count = t('archivePageItemCount').replace('{count}', number(row.ids.size));
          return h('details', { key: row.index, className: 'reader-process turn-process' }, [
            h('summary', { key: 'label', className: 'reader-summary' },
              [t('archiveProcess'), count, branch].filter(Boolean).join(' · ')),
            h('div', { key: 'body', className: 'reader-process-items' }, row.items.map(({ item, index }) => renderItem(item, index))),
          ]);
        }
        const shortTitle = turn => turn.title || (turn.id === page?.continuedTurn ? t('archiveContinued') : '');
        const nextPage = () => move([...locations, { cursor: page.nextCursor }]);
        return h('div', { className: 'history-browser', hidden }, [
          h('aside', { key: 'index', className: 'turn-index', 'aria-label': t('archiveIndex') }, [
            h('header', { key: 'header', className: 'index-heading' }, [
              h('h3', { key: 'title' }, t('archiveIndex')),
              h('details', { key: 'jump', className: 'index-jump' }, [
                h('summary', { key: 'summary' }, t('archiveJump')),
                h('form', { key: 'form', className: 'reader-jump', onSubmit: event => {
                  event.preventDefault();
                  const input = event.currentTarget.elements.namedItem('turn');
                  const turn = input.valueAsNumber;
                  if (Number.isSafeInteger(turn) && turn > 0) {
                    const disclosure = event.currentTarget.parentElement;
                    disclosure.open = false;
                    disclosure.querySelector('summary').focus();
                    move([{ turn }]);
                  }
                } }, [
                  h('input', { key: 'input', type: 'number', name: 'turn', min: '1', required: true,
                    placeholder: t('archiveRound'), 'aria-label': t('archiveRound') }),
                  h('button', { key: 'go', type: 'submit', className: 'reader-button' }, t('archiveGo')),
                ]),
              ]),
            ]),
            h('div', { key: 'turns', className: 'index-list' }, turns.map(turn =>
              h('button', { key: turn.id, type: 'button', 'aria-current': active?.id === turn.id ? 'true' : undefined,
                title: [round(turn.id), shortTitle(turn)].filter(Boolean).join(' · '), onClick: () => setSelected(turn.id) }, [
                h('span', { key: 'number', className: 'index-number', 'aria-label': round(turn.id) }, turn.id ? String(turn.id).padStart(2, '0') : '…'),
                h('span', { key: 'title' }, shortTitle(turn) || round(turn.id)),
              ]))),
            h('select', { key: 'select', className: 'compact-turns', 'aria-label': t('archiveIndex'), value: active?.id ?? '',
              disabled: !turns.length, onChange: event => setSelected(Number(event.target.value)) },
              turns.map(turn => h('option', { key: turn.id, value: turn.id }, [round(turn.id), shortTitle(turn)].filter(Boolean).join(' · ')))),
            h('nav', { key: 'nav', className: 'index-pages', 'aria-label': t('archiveIndex') }, [
              (locations.length > 1 || locator.turn) ? button('first', 'archiveFirst', () => move([{}])) : null,
              h('span', { key: 'page', role: 'status' }, t('archivePage').replace('{page}', number(locations.length))),
              button('previous', 'archivePrevious', () => move(locations.slice(0, -1)), locations.length === 1, 'back'),
              button('next', 'archiveNext', nextPage, !page?.nextCursor, 'next'),
            ]),
          ]),
          h('section', { key: 'reading', ref: records, className: 'turn-sheet', tabIndex: 0, 'aria-label': t('archiveTitle') }, [
            !current ? h('p', { key: 'loading', role: 'status' }, t('archiveLoading')) : null,
            current?.failed ? h('div', { key: 'failure' }, [h('p', { key: 'error', role: 'status' }, t('traceFailed')),
              button('retry', 'archiveRetry', () => setAttempt(value => value + 1))]) : null,
            page && !turns.length ? h('p', { key: 'empty', role: 'status' }, t(locator.turn ? 'archiveMissingTurn' : 'archiveEmpty')) : null,
            active && h('div', { key: [locator.cursor, locator.turn, active.id].join(':'), className: 'turn-page' }, [
              active.rows[0]?.item?.kind !== 'message' && h('h3', { key: 'heading', className: 'turn-heading' }, turnTitle),
              ...active.rows.map(renderRow),
              active.id === page.continuesTurn && page.nextCursor ? button('continue', 'archiveMore', nextPage) : null,
            ]),
            h('p', { key: 'notice', role: 'status', className: 'reader-note' }, notice),
          ]),
        ]);
      }

      // The header slot is clipped, so the panel portals to the document body.
      // Trace is read-only reference material: nothing here is sent back to DSH
      // as an event, and no tool is executed.
      function SourceTrace({ sessionId, t }) {
        const [sourceRecord, setSourceRecord] = useState();
        const [showDetails, setShowDetails] = useState(false);
        const [open, setOpen] = useState(false);
        const [error, setError] = useState('');
        const [copied, setCopied] = useState('');
        const modal = useRef(null);
        const trigger = useRef(null);
        useEffect(() => {
          setOpen(false);
          setError('');
          setCopied('');
          if (typeof sessionId !== 'string' || !sessionId) return undefined;
          const controller = new AbortController();
          const url = new URL(`agent-bridge/session-trace?sessionId=${encodeURIComponent(sessionId)}`, document.baseURI);
          fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
            .then(response => response.ok ? response.json() : undefined)
            .then(value => {
              if (controller.signal.aborted) return;
              const readable = Boolean(value?.history) || (Array.isArray(value?.trace) && (value.trace.length || value.sourceStats));
              setSourceRecord(readable ? { sessionId, value } : undefined);
            })
            .catch(() => {});
          return () => controller.abort();
        }, [sessionId]);
        useEffect(() => {
          if (!open) return undefined;
          const element = modal.current;
          if (!element) return undefined;
          element.showModal();
          return () => {
            element.close();
            trigger.current?.focus({ preventScroll: true });
          };
        }, [open]);
        const copy = useCallback(async item => {
          try {
            await navigator.clipboard.writeText(item.text ?? '');
            setCopied(item.id);
            setTimeout(() => setCopied(current => current === item.id ? '' : current), 1600);
          } catch {
            setError('无法写入剪贴板，请手动选择文本。');
          }
        }, []);
        if (!sourceRecord || sourceRecord.sessionId !== sessionId) return null;
        const { trace = [], sourceStats, traceCounts, history } = sourceRecord.value;

        const turns = new Map();
        for (const item of trace) {
          const items = turns.get(item.turn);
          if (items) items.push(item);
          else turns.set(item.turn, [item]);
        }
        const renderItem = (item, index) => h('article', { key: item.id || `${index}`, className: 'reader-excerpt' }, [
          h('div', { key: 'meta', className: 'reader-excerpt-meta' }, [
            h('span', { key: 'kind', className: 'reader-kind' }, traceKind[item.kind] ?? item.kind),
            item.name ? h('code', { key: 'name', className: 'reader-name' }, item.name) : null,
            item.callId ? h('code', { key: 'call', className: 'reader-name' }, `${t('traceCall')} ${item.callId}`) : null,
            traceState[item.status] ? h('span', { key: 'state', className: 'reader-note' }, traceState[item.status]) : null,
            item.truncated && item.status !== 'truncated' ? h('span', { key: 'cut', className: 'reader-note' }, '已截取') : null,
            item.kind === 'tool_result' && item.text
              ? h('button', {
                key: 'copy', type: 'button', className: 'reader-button',
                onClick: () => copy(item),
              }, copied === item.id ? t('traceCopied') : t('traceCopy'))
              : null,
          ]),
          h('p', { key: 'text', className: 'reader-body' }, item.text || (item.kind === 'tool_result' ? t('traceEmpty') : '')),
        ]);
        let theme = 'white';
        if (open) {
          try { theme = localStorage.getItem('dsh-agent-bridge.theme') || theme; } catch { /* Use the light palette. */ }
        }
        const detailsVisible = showDetails || !history;
        const dialog = open && h('dialog', {
          ref: modal, className: 'bridge-reader bridge-reader-dialog', 'data-theme': theme, 'aria-label': t('traceTitle'),
          onCancel: event => { event.preventDefault(); setOpen(false); },
          onClick: event => {
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false);
          },
        }, [
          h('link', { key: 'css', rel: 'stylesheet', href: new URL('agent-bridge/reader.css', document.baseURI).href }),
          h('header', { key: 'head', className: 'reader-header' }, [
            h('span', { key: 'icon', className: 'reader-emblem' }, readerIcon('book')),
            h('div', { key: 'identity', className: 'record-identity' }, [
              h('h2', { key: 'title' }, t('traceTitle')),
              sourceStats && h('span', { key: 'size' }, t('statsOverview').replace('{turns}', number(sourceStats.userMessages))
                .replace('{messages}', number(sourceStats.userMessages + sourceStats.assistantMessages))),
              history?.complete === false && h('span', { key: 'partial', className: 'record-partial',
                title: t('archivePartial') }, t('archiveUnclear')),
            ]),
            history && h('button', { key: 'details', type: 'button', className: 'record-mode',
              'aria-expanded': showDetails, 'aria-label': t(showDetails ? 'archiveRead' : 'archiveDetails'),
              onClick: () => setShowDetails(value => !value) }, [
              readerIcon(showDetails ? 'book' : 'settings'), t(showDetails ? 'archiveRead' : 'archiveDetailsShort'),
            ]),
            h('button', { key: 'close', type: 'button', className: 'record-icon', 'aria-label': t('traceClose'),
              title: t('traceClose'), onClick: () => setOpen(false) }, readerIcon('close')),
          ]),
          history && h(SourceArchive, { key: sessionId, sessionId, t, hidden: detailsVisible }),
          h('div', { key: 'content', hidden: !detailsVisible, className: 'reader-content' }, [
            h(SourceStats, { key: 'stats', stats: sourceStats, counts: traceCounts, t }),
            history && h(ArchiveDetails, { key: 'export', history, sessionId, t }),
            error ? h('p', { key: 'error', className: 'reader-alert', role: 'status' }, error) : null,
            trace.length ? h('details', { key: 'excerpts', className: 'reader-extra', open: !history }, [
              h('summary', { key: 'title', className: 'reader-summary' }, t('traceExcerpt')),
              ...Array.from(turns, ([turn, items]) => {
                const title = turn ? t('traceTurn').replace('{turn}', turn) : t('traceUnnumbered');
                const count = items.length === 1 ? t('traceOneItem') : t('traceItemCount').replace('{count}', items.length);
                return h('details', { key: turn ?? 'unnumbered', className: 'reader-process' }, [
                  h('summary', { key: 'summary', className: 'reader-summary' }, [
                    h('span', { key: 'title' }, title),
                    h('small', { key: 'count' }, count),
                  ]),
                  h('div', { key: 'items', className: 'reader-process-items' }, items.map(renderItem)),
                ]);
              }),
            ]) : null,
          ]),
        ]);
        return [
          h('button', {
            key: 'trigger', ref: trigger, type: 'button', 'aria-haspopup': 'dialog',
            style: { color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer', padding: '3px 8px',
              background: 'transparent', border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', borderRadius: '5px' },
            title: t('traceTitle'), onClick: () => { setShowDetails(false); setOpen(true); },
          }, t('trace')),
          dialog && typeof document !== 'undefined' ? createPortal(dialog, document.body) : null,
        ];
      }

      function Panel() {
        const iframe = useRef(null);
        const url = new URL('agent-bridge/panel', document.baseURI).href;

        useEffect(() => {
          const lifetime = new AbortController();
          async function onMessage(event) {
            const frame = iframe.current;
            if (!frame || event.source !== frame.contentWindow || event.origin !== window.origin) return;
            try {
              if (event.source.location.href !== url) return;
            } catch {
              return;
            }
            const request = event.data;
            if (typeof request?.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.requestId)) return;
            const reply = (result) => {
              if (iframe.current !== frame) return;
              event.source.postMessage({ type: 'dsh-agent-bridge:result', requestId: request.requestId, ...result },
                event.origin === 'null' ? '*' : event.origin);
            };

            if (request.type === 'dsh-agent-bridge:sessions' || request.type === 'dsh-agent-bridge:session-export') {
              try {
                const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]);
                reply({ ok: true, ...await exportRequest(request, signal) });
              } catch (error) {
                reply({ ok: false, error: error instanceof Error ? error.message.slice(0, 500) : '无法导出 DSH 会话。' });
              }
              return;
            }
            if (request.type === 'dsh-agent-bridge:open-imported') {
              try {
                await ctx.sessions.refresh();
                const snapshot = ctx.sessions.list.getSnapshot();
                if (!Object.hasOwn(snapshot.byId, request.sessionId)) throw new Error('会话已保存，请从工作区列表打开。');
                if (iframe.current === frame) ctx.uiWorkspace.openSession(request.sessionId);
                reply({ ok: true });
              } catch (error) {
                reply({ ok: false, error: error instanceof Error ? error.message.slice(0, 500) : '会话已保存，请从工作区列表打开。' });
              }
              return;
            }
            if (request.type === 'dsh-agent-bridge:quote-history') {
              try {
                await quoteHistory(request.sessionId, request.text);
                if (iframe.current === frame) ctx.uiWorkspace.openSession(request.sessionId);
                reply({ ok: true });
              } catch (error) {
                reply({ ok: false, error: error instanceof Error ? error.message : '无法填入草稿。' });
              }
              return;
            }
            if (request.type === 'dsh-agent-bridge:pick-history-directory') {
              try {
                const path = await ctx.uiWorkspace.pickDirectory();
                if (path !== null && !validPath(path)) throw new Error('目录格式无效。');
                reply({ ok: true, path });
              } catch {
                reply({ ok: false, error: '无法打开目录选择器，请输入本机绝对路径。' });
              }
              return;
            }
            if (request.type === 'dsh-agent-bridge:recover-draft') {
              const partial = recentImports.get(request.requestId);
              if (importing || !partial || partial.ready || partial.sessionId !== request.sessionId) {
                reply({ ok: false, error: '无法定位这条交接会话，请回到工作区检查。' });
                return;
              }
              try {
                ctx.uiWorkspace.openSession(partial.sessionId);
                reply({ ok: true });
              } catch {
                reply({ ok: false, error: '暂时无法打开这条会话，请在工作区列表中重试。' });
              }
              return;
            }
            if (request.type === 'dsh-agent-bridge:open-path') {
              const { projectId, directory, assetId, referenceId, bridgeNonce } = request;
              if (!/^[a-f0-9]{24}$/.test(projectId) || !/^[a-f0-9]{64}$/.test(bridgeNonce)
                || (directory !== true && !/^[a-f0-9]{24}$/.test(assetId) && !/^[a-f0-9-]{36}$/.test(referenceId))) {
                reply({ ok: false, error: '文件引用格式无效。' });
                return;
              }
              try {
                const session = ctx.remote.session;
                if (typeof session.openWorkspacePath !== 'function') {
                  reply({ ok: false, error: '当前 DSH 不支持打开本机文件，可复制路径。' });
                  return;
                }
                if (typeof session.canOpenWorkspacePath === 'function') {
                  const availability = await session.canOpenWorkspacePath();
                  if (!availability?.ok) {
                    reply({ ok: false, error: '无法确认本机文件打开能力，可复制路径。' });
                    return;
                  }
                  if (availability.value !== true) {
                    reply({ ok: false, error: '当前 DSH 不支持打开本机文件，可复制路径。' });
                    return;
                  }
                }
                const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]);
                const resolve = async () => {
                  const response = await fetch(new URL('api', url), {
                    method: 'POST', signal,
                    headers: { 'Content-Type': 'application/json', 'X-DSH-Agent-Bridge': bridgeNonce },
                    body: JSON.stringify({ action: 'resolve-open-path', projectId, directory, assetId, referenceId }),
                  });
                  const target = await response.json();
                  if (!response.ok || !validPath(target.path)) throw new Error(target.error || '无法核对文件路径。');
                  return target;
                };
                const target = await resolve();
                const opened = await session.openWorkspacePath({ path: target.path,
                  ...(target.revealOnly ? { action: 'reveal' } : {}),
                }, signal);
                if (opened?.ok) {
                  reply({ ok: true, revealed: target.revealOnly === true });
                  return;
                }
                // A viewer may be unavailable for an extension while the file
                // manager is not; revealing still gives the user the file.
                const revealed = !target.revealOnly
                  && await session.openWorkspacePath({ path: (await resolve()).path, action: 'reveal' }, signal);
                reply(revealed?.ok
                  ? { ok: true, revealed: true }
                  : { ok: false, error: 'DSH 未能打开这个文件，可复制路径后在资源管理器中查看。' });
              } catch (error) {
                reply({ ok: false, error: error instanceof Error
                  ? error.message.slice(0, 500) : 'DSH 未能打开这个文件，可复制路径。' });
              }
              return;
            }
            if (request.type !== 'dsh-agent-bridge:open') return;
            if (!validPath(request.path) || typeof request.prompt !== 'string'
              || !request.prompt.trim() || request.prompt.length > 65_536) {
              reply({ ok: false, error: '项目目录或交接草稿格式无效。' });
              return;
            }
            if (importing) {
              reply({ ok: false, error: '另一个项目正在导入。' });
              return;
            }
            importing = true;
            try {
              const sessionId = await prepareSession(request, (id) => {
                if (iframe.current !== frame) return;
                ctx.uiWorkspace.openSession(id);
                if (typeof request.bridgeNonce === 'string' && /^[a-f0-9]{64}$/.test(request.bridgeNonce)) {
                  // The native workspace may replace the panel before it receives the reply.
                  void fetch(new URL('api', url), {
                    method: 'POST', keepalive: true,
                    headers: { 'Content-Type': 'application/json', 'X-DSH-Agent-Bridge': request.bridgeNonce },
                    body: JSON.stringify({ action: 'record-project-continuation', ticket: request.requestId }),
                  }).catch(() => {});
                }
              });
              reply({ ok: true, sessionId });
            } catch (error) {
              const partial = recentImports.get(request.requestId);
              reply({
                ok: false,
                recoverySessionId: partial?.ready === false ? partial.sessionId : undefined,
                error: error instanceof Error ? error.message.slice(0, 500) : 'DSH 无法打开交接会话。',
              });
            } finally {
              importing = false;
            }
          }

          window.addEventListener('message', onMessage);
          return () => {
            lifetime.abort();
            window.removeEventListener('message', onMessage);
          };
        }, [url]);

        return h('iframe', {
          ref: iframe,
          src: url,
          title: t('title'),
          referrerPolicy: 'no-referrer',
          style: { display: 'block', width: '100%', height: '100%', border: 0 },
        });
      }

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: panelId, locale: panelId,
      }, Panel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: panelId, order: 20, label: () => t('title'), locale: panelId,
      }, PanelIcon));
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions', id: 'agent-bridge-trace', order: 30, locale: panelId,
      }, SourceTrace));
      ctx.effect(() => ctx.uiConversation?.events.register(inlineProcessDefinition), 'agent bridge process projection');
      ctx.effect(() => {
        if (!document.head) return;
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = new URL('agent-bridge/inline-process.css', document.baseURI).href;
        document.head.append(css);
        return () => css.remove();
      }, 'agent bridge process stylesheet');
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node', key: inlineProcessNode, locale: panelId,
      }, InlineProcessNode));
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail', id: 'agent-bridge-inline-process', order: 30, locale: panelId,
      }, InlineProcessTail));
    }

    return { apply, inject: ['slots', 'locale', 'uiWorkspace', 'workspaces', 'sessions', 'conversation', 'uiConversation', 'remote', 'remote.session'] };
  },
});
