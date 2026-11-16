window.__ModuleLoader__.load({
  id: '@wwwfz/dsh-agent-bridge',
  factory: (require) => {
    const { createElement: h, useEffect, useRef } = require('react');
    const panelId = 'dsh-agent-bridge';
    const messages = {
      zh: { title: 'Agent 工作接续' },
      en: { title: 'Agent Workspace Handoff' },
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
    }

    return { apply, inject: ['slots', 'locale', 'uiWorkspace', 'workspaces', 'sessions', 'conversation', 'remote', 'remote.session'] };
  },
});
