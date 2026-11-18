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
        traceHint: '展开回合查看旧 Agent 的思考摘要和工具记录。',
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
      },
      en: {
        title: 'Agent Workspace Handoff',
        trace: 'Source record',
        traceTitle: 'Source record',
        traceHint: 'Expand a turn to view reasoning summaries and tool records.',
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

      const traceKind = { summary: '思考摘要', tool_call: '工具调用', tool_result: '工具结果' };
      const traceState = { missing: '未记录结果', error: '失败', pending: '未完成', truncated: '已截取' };
      const traceStyle = {
        overlay: {
          position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex',
          alignItems: 'center', justifyContent: 'center', padding: '24px',
          background: 'rgba(0, 0, 0, 0.42)',
        },
        dialog: {
          width: 'min(720px, 100%)', maxHeight: 'min(76vh, 760px)', overflow: 'auto',
          borderRadius: '14px', padding: '20px 22px', background: 'var(--dsh-surface, #fff)',
          color: 'var(--dsh-text, #1f2328)', boxShadow: '0 24px 64px rgba(0, 0, 0, 0.32)',
          font: '13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif',
        },
        header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
        heading: { margin: 0, fontSize: '15px', fontWeight: 600 },
        hint: { margin: '6px 0 14px', opacity: 0.7, fontSize: '12px' },
        stats: {
          marginBlock: '12px 8px', padding: '10px 12px', borderRadius: '9px',
          border: '1px solid var(--dsh-border, rgba(127, 127, 127, 0.22))',
        },
        statsHeading: { margin: 0, fontSize: '13px', fontWeight: 650 },
        statsGrid: {
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(104px, 100%), 1fr))',
          gap: '8px 12px', margin: '7px 0 0',
        },
        statsLabel: { opacity: 0.75, fontSize: '12px' },
        statsValue: { margin: 0, fontSize: '17px', fontWeight: 620, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
        statsNote: { margin: '6px 0 0', opacity: 0.75, fontSize: '12px' },
        turn: { borderTop: '1px solid var(--dsh-border, rgba(127, 127, 127, 0.22))' },
        turnSummary: { display: 'list-item', padding: '9px 0', cursor: 'pointer', fontWeight: 600 },
        turnCount: { marginInlineStart: '9px', fontSize: '12px', fontWeight: 400, opacity: 0.72 },
        turnItems: { paddingInlineStart: '15px', paddingBottom: '5px' },
        item: {
          borderTop: '1px solid var(--dsh-border, rgba(127, 127, 127, 0.22))',
          padding: '10px 0', display: 'grid', gap: '4px',
        },
        meta: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', fontSize: '12px' },
        kind: { fontWeight: 600 },
        name: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '12px' },
        state: { opacity: 0.72 },
        body: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
        button: {
          border: '1px solid var(--dsh-border, rgba(127, 127, 127, 0.3))',
          background: 'transparent', color: 'inherit', borderRadius: '7px',
          padding: '3px 9px', fontSize: '12px', cursor: 'pointer',
        },
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
        return h('section', { style: traceStyle.stats, 'aria-label': t('statsTitle') }, [
          h('h3', { key: 'title', style: traceStyle.statsHeading }, t('statsTitle')),
          h('dl', { key: 'values', style: traceStyle.statsGrid }, values.map(([label, value]) => h('div', { key: label }, [
            h('dt', { key: 'label', style: traceStyle.statsLabel }, t(label)),
            h('dd', { key: 'value', style: traceStyle.statsValue }, value),
          ]))),
          notes.length ? h('p', { key: 'notes', style: traceStyle.statsNote }, notes.join(' · ')) : null,
          scope ? h('p', { key: 'scope', style: traceStyle.statsNote }, scope) : null,
        ]);
      }

      // The header slot is clipped, so the panel portals to the document body.
      // Trace is read-only reference material: nothing here is sent back to DSH
      // as an event, and no tool is executed.
      function SourceTrace({ sessionId, t }) {
        const [sourceRecord, setSourceRecord] = useState();
        const [open, setOpen] = useState(false);
        const [error, setError] = useState('');
        const [copied, setCopied] = useState('');
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
              const readable = Array.isArray(value?.trace) && (value.trace.length || value.sourceStats);
              setSourceRecord(readable ? { sessionId, value } : undefined);
            })
            .catch(() => {});
          return () => controller.abort();
        }, [sessionId]);
        useEffect(() => {
          if (!open) return undefined;
          const dismiss = event => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            setOpen(false);
          };
          document.addEventListener('keydown', dismiss);
          return () => document.removeEventListener('keydown', dismiss);
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
        const { trace, sourceStats, traceCounts } = sourceRecord.value;

        const turns = new Map();
        for (const item of trace) {
          const items = turns.get(item.turn);
          if (items) items.push(item);
          else turns.set(item.turn, [item]);
        }
        const renderItem = (item, index) => h('article', { key: item.id || `${index}`, style: traceStyle.item }, [
          h('div', { key: 'meta', style: traceStyle.meta }, [
            h('span', { key: 'kind', style: traceStyle.kind }, traceKind[item.kind] ?? item.kind),
            item.name ? h('code', { key: 'name', style: traceStyle.name }, item.name) : null,
            item.callId ? h('code', { key: 'call', style: traceStyle.name }, `${t('traceCall')} ${item.callId}`) : null,
            traceState[item.status] ? h('span', { key: 'state', style: traceStyle.state }, traceState[item.status]) : null,
            item.truncated && item.status !== 'truncated' ? h('span', { key: 'cut', style: traceStyle.state }, '已截取') : null,
            item.kind === 'tool_result' && item.text
              ? h('button', {
                key: 'copy', type: 'button', style: traceStyle.button,
                onClick: () => copy(item),
              }, copied === item.id ? t('traceCopied') : t('traceCopy'))
              : null,
          ]),
          h('p', { key: 'text', style: traceStyle.body }, item.text || (item.kind === 'tool_result' ? t('traceEmpty') : '')),
        ]);
        const dialog = open && h('div', {
          style: traceStyle.overlay,
          onMouseDown: event => { if (event.target === event.currentTarget) setOpen(false); },
        }, h('div', {
          role: 'dialog', 'aria-modal': true, 'aria-label': t('traceTitle'), style: traceStyle.dialog,
        }, [
          h('div', { key: 'head', style: traceStyle.header }, [
            h('h2', { key: 'title', style: traceStyle.heading }, t('traceTitle')),
            h('button', { key: 'close', type: 'button', style: traceStyle.button, onClick: () => setOpen(false) }, t('traceClose')),
          ]),
          h(SourceStats, { key: 'stats', stats: sourceStats, counts: traceCounts, t }),
          trace.length ? h('p', { key: 'hint', style: traceStyle.hint }, t('traceHint')) : null,
          error ? h('p', { key: 'error', style: { ...traceStyle.hint, color: '#b42318' } }, error) : null,
          ...Array.from(turns, ([turn, items]) => {
            const title = turn ? t('traceTurn').replace('{turn}', turn) : t('traceUnnumbered');
            const count = items.length === 1 ? t('traceOneItem') : t('traceItemCount').replace('{count}', items.length);
            return h('details', { key: turn ?? 'unnumbered', style: traceStyle.turn }, [
              h('summary', { key: 'summary', style: traceStyle.turnSummary }, [
                h('span', { key: 'title' }, title),
                h('span', { key: 'count', style: traceStyle.turnCount }, count),
              ]),
              h('div', { key: 'items', style: traceStyle.turnItems }, items.map(renderItem)),
            ]);
          }),
        ]));
        return [
          h('button', {
            key: 'trigger', type: 'button', style: traceStyle.button,
            title: t('traceTitle'), onClick: () => setOpen(value => !value),
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
    }

    return { apply, inject: ['slots', 'locale', 'uiWorkspace', 'workspaces', 'sessions', 'conversation', 'remote', 'remote.session'] };
  },
});
