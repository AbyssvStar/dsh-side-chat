/**
 * dsh-side-chat — browser half.
 *
 * Codex-style side chat on top of the stock DSH pieces:
 *
 *   - a side chat IS a forked session (`sessions.fork` with the closing seq of
 *     the turn the user clicked), so it inherits the whole prefix and can use
 *     every tool; it just never takes over the main window;
 *   - the fork is rendered in the right sidebar by a `dsh-resource://sidechat/…`
 *     tab, reusing the stock conversation renderer instead of a second chat UI;
 *   - the main line is never touched: the fork is a copy, not a view.
 *
 * The only behavioural difference from the built-in Branch command is the last
 * step — Branch calls `uiWorkspace.openSession(child)`; we open a sidebar
 * resource instead.
 */

window.__ModuleLoader__.load({
  id: 'dsh-side-chat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { jsx, Fragment } = require('react/jsx-runtime')

    //#region contract

    /** Dictionary namespace owned by this plugin. */
    const NS = 'sideChat'
    /** Stable ids; the tab key and the slot key must match. */
    const PLUGIN_ID = 'dsh-side-chat'
    const KIND = 'sidechat'
    const PROTOCOL = 'sidechat'
    /** Address prefix of one side-chat tab: `dsh-resource://sidechat/session/<child>?parent=…&at=…`. */
    const PREFIX = `dsh-resource://${PROTOCOL}/session/`
    /** Child slot rendered inside the tab body. */
    const SURFACE = 'sidechat.conversation'
    /** localStorage key of the child → origin map, so a reload keeps `carry back` working. */
    const STORE_KEY = 'dsh.side-chat.v1'
    /** Host route serving a side chat's last answer. */
    const HANDOFF_URL = '/side-chat/handoff'
    const CONTEXT_URL = '/side-chat/context'

    /**
     * Which session each open side chat was forked from.
     * @type {Map<string, {parentSessionId: string, atSeq: number}>}
     */
    const origins = new Map()

    /** Services this plugin reads. */
    const inject = [
      'sessions',
      'resources',
      'sidebarRight',
      'sidebarRightTabs',
      'slots',
      'locale',
    ]

    //#endregion

    //#region dictionary

    const zh = {
      'tab.title': '侧聊',
      'action.open': '侧聊',
      'action.openHint': '从这一轮分出一条侧聊，在右侧栏继续聊；主线不受影响',
      'action.openFailed': '侧聊创建失败，请重试',
      'action.carry': '带回主线',
      'action.carryHint': '把这个侧聊最后的结论放进主线的输入框，先给你过目再发送；按住 Shift 点击则作为背景放进主线上下文',
      'action.carryFailed': '带回失败：这个侧聊还没有可以带回的结论',
      'action.carryDrafted': '已放进主线输入框',
      'action.carryInjected': '已作为背景放进主线上下文',
      'action.carrySent': '主线的输入框正忙，已作为消息直接发给主线',
    }

    const en = {
      'tab.title': 'Side chat',
      'action.open': 'Side chat',
      'action.openHint': 'Branch this turn into a side chat on the right; the main line stays untouched',
      'action.openFailed': 'Could not open a side chat — try again',
      'action.carry': 'Carry back',
      'action.carryHint': "Put this side chat's conclusion into the main composer for review before sending; hold Shift to queue it as background context instead",
      'action.carryFailed': 'Nothing to carry back yet — this side chat has no answer',
      'action.carryDrafted': 'Put into the main composer',
      'action.carryInjected': 'Queued as background context on the main line',
      'action.carrySent': 'The main composer was busy, so it was sent as a message instead',
    }

    //#endregion

    //#region address

    /**
     * Build the resource address of one side-chat tab.
     * @param {string} childSessionId - the forked session.
     * @param {string} parentSessionId - the session the fork came from.
     * @param {number} atSeq - closing seq of the turn the fork was taken from.
     * @returns {string} `dsh-resource://sidechat/session/<child>?parent=…&at=…`
     */
    function buildAddress(childSessionId, parentSessionId, atSeq) {
      const query = new URLSearchParams({
        parent: parentSessionId,
        at: String(atSeq),
      })
      return `${PREFIX}${encodeURIComponent(childSessionId)}?${query.toString()}`
    }

    /**
     * Parse a side-chat address.
     * @param {string} value - candidate address.
     * @returns {{address: string, childSessionId: string, parentSessionId: string, atSeq: number} | undefined}
     */
    function parseAddress(value) {
      let url
      try {
        url = new URL(value)
      } catch {
        return undefined
      }
      if (url.protocol !== 'dsh-resource:') return undefined
      if (url.hostname.toLowerCase() !== PROTOCOL) return undefined
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts.length !== 2 || parts[0] !== 'session') return undefined
      const parentSessionId = url.searchParams.get('parent')
      const atParam = url.searchParams.get('at')
      if (parentSessionId === null || parentSessionId === '') return undefined
      if (atParam === null || atParam.trim() === '') return undefined
      const at = Number(atParam)
      if (!Number.isFinite(at)) return undefined
      return {
        address: value,
        childSessionId: decodeURIComponent(parts[1]),
        parentSessionId,
        atSeq: at,
      }
    }

    //#endregion

    //#region resource

    /**
     * Resolve a side-chat address into a retained session reference, for as long
     * as the tab that shows it stays open.
     * @param {object} sessions - the client `sessions` service.
     * @returns {object} resource provider for `ctx.resources.register`.
     */
    function resourceProvider(sessions) {
      return {
        protocol: PROTOCOL,
        async *open(address, { signal }) {
          const parsed = parseAddress(address)
          if (parsed === undefined) {
            throw new Error(`dsh-side-chat: invalid side-chat address "${address}"`)
          }
          if (signal.aborted) return
          const reference = sessions.retain(parsed.childSessionId, {
            source: 'sidebarChat',
            signal,
          })
          try {
            yield { ok: true, value: { ...parsed, reference } }
            await waitForAbort(signal)
          } finally {
            reference.release()
          }
        },
      }
    }

    /**
     * Resolve once `signal` aborts; the resource stays retained until then.
     * @param {AbortSignal} signal - resource lifetime signal.
     * @returns {Promise<void>}
     */
    function waitForAbort(signal) {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }

    //#endregion

    //#region fork

    /**
     * Fork a turn into a side chat and show it in the right sidebar.
     *
     * Deliberately does NOT call `uiWorkspace.openSession`: the fork must not
     * take over the main window, that is the whole difference from Branch.
     *
     * @param {object} ctx - client root context.
     * @param {string} parentSessionId - session the turn belongs to.
     * @param {number} atSeq - closing seq of the turn.
     * @returns {Promise<string>} the forked session id.
     */
    async function openSideChat(ctx, parentSessionId, atSeq) {
      const childSessionId = await ctx.sessions.fork({
        sessionId: parentSessionId,
        atSeq,
        increaseTitle: false,
      })
      rememberOrigin(childSessionId, parentSessionId, atSeq)
      ctx.sidebarRight.openResource(
        buildAddress(childSessionId, parentSessionId, atSeq),
      )
      return childSessionId
    }

    //#endregion

    //#region origins

    /**
     * Record where a side chat came from, so its turn footer can offer
     * `carry back` even after a reload rebuilt the sidebar tabs.
     * @param {string} childSessionId - forked session.
     * @param {string} parentSessionId - session it came from.
     * @param {number} atSeq - closing seq of the turn.
     */
    function rememberOrigin(childSessionId, parentSessionId, atSeq) {
      origins.set(childSessionId, { parentSessionId, atSeq })
      try {
        const stored = {}
        for (const [child, origin] of origins) stored[child] = origin
        globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(stored))
      } catch {
        // A browser with storage disabled still works; the map is in memory.
      }
    }

    /** Reload the child → origin map written by an earlier page load. */
    function restoreOrigins() {
      let parsed
      try {
        const raw = globalThis.localStorage?.getItem(STORE_KEY)
        if (typeof raw !== 'string' || raw === '') return
        parsed = JSON.parse(raw)
      } catch {
        return
      }
      if (parsed === null || typeof parsed !== 'object') return
      for (const [child, origin] of Object.entries(parsed)) {
        if (origin === null || typeof origin !== 'object') continue
        if (typeof origin.parentSessionId !== 'string' || origin.parentSessionId === '') continue
        if (typeof origin.atSeq !== 'number' || !Number.isFinite(origin.atSeq)) continue
        origins.set(child, { parentSessionId: origin.parentSessionId, atSeq: origin.atSeq })
      }
    }

    /**
     * Where a session was forked from, when this browser opened it as a side chat.
     * @param {string} sessionId - candidate session.
     * @returns {{parentSessionId: string, atSeq: number} | undefined}
     */
    function originOf(sessionId) {
      return origins.get(sessionId)
    }

    //#endregion

    //#region carry-back

    /**
     * Ask the host for a side chat's newest answer text.
     * @param {string} childSessionId - side chat to read.
     * @returns {Promise<{text: string, turn: number | null}>}
     */
    async function fetchAnswer(childSessionId) {
      const url = `${HANDOFF_URL}?child=${encodeURIComponent(childSessionId)}`
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      const body = await response.json()
      if (response.ok !== true || body?.ok !== true) {
        throw new Error(body?.error ?? `handoff failed with ${response.status}`)
      }
      if (typeof body.text !== 'string' || body.text.trim() === '') {
        throw new Error('this side chat has no answer yet')
      }
      return { text: body.text, turn: typeof body.turn === 'number' ? body.turn : null }
    }

    /**
     * Wrap an answer as something the main line can act on.
     *
     * The fork point is recorded as a log seq, not a turn index, so the note
     * names no round: a wrong number reads as a wrong citation.
     *
     * @param {string} text - answer body.
     * @returns {string} composer text.
     */
    function composeNote(text) {
      return `侧聊的结论：\n\n${text.trim()}`
    }

    /**
     * Wrap a hand-picked passage as something the main line can act on.
     * @param {string} text - selected passage.
     * @returns {string} composer text.
     */
    function composeQuote(text) {
      return `侧聊里引用的内容：\n\n${text.trim()}`
    }

    /** Longest selection carried back verbatim; past this it is a document, not a quote. */
    const MAX_SELECTION = 4000

    /**
     * Read the passage the user highlighted, if any.
     *
     * Selection is a browser-wide fact, not a per-tab one, so this can pick up
     * text from any pane. That is the intent: quoting what you are looking at
     * works the same whether it sits in the side chat or beside it.
     *
     * @returns {string} trimmed selection, empty when there is none.
     */
    function selectedText() {
      try {
        const selection = globalThis.getSelection?.()
        const text = typeof selection?.toString === 'function' ? selection.toString() : ''
        if (typeof text !== 'string') return ''
        const trimmed = text.trim()
        return trimmed.length > MAX_SELECTION ? trimmed.slice(0, MAX_SELECTION) : trimmed
      } catch {
        return ''
      }
    }

    /**
     * Ask the host to queue a note on the main line's model-facing context.
     *
     * The host owns this because only it can reach a live agent, and only the
     * agent can persist a `user/message` the model will see next turn. Nothing
     * is woken: an idle main line stays idle until the user speaks.
     *
     * @param {string} sessionId - main-line session that should learn the note.
     * @param {string} text - note body.
     * @returns {Promise<void>} resolves once the host accepted the note.
     */
    async function postContext(sessionId, text) {
      const response = await fetch(CONTEXT_URL, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, text }),
      })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (response.ok !== true || body?.ok !== true) {
        throw new Error(body?.error ?? `context injection failed with ${response.status}`)
      }
    }

    /**
     * Put a side chat's answer into the main line.
     *
     * Preferred carrier is the parent's draft: the user sees it, can edit it,
     * and nothing is said to the model until they send. When the composer is
     * not available (not mounted, or a submission is in flight) the answer is
     * sent as a user message instead — the only other durable, model-visible
     * channel this plugin has.
     *
     * Asking for context instead (`options.inject`) queues the same text as
     * model-facing background: the main line learns the conclusion without the
     * plugin putting words in the user's mouth. That path needs a live agent, so
     * it degrades to the draft when the host says the session is cold.
     *
     * A highlighted passage wins over the whole answer: asking to carry back
     * while text is selected means that text, and carrying an entire answer to
     * quote two lines of it is the failure mode this avoids.
     *
     * @param {object} ctx - client root context.
     * @param {string} childSessionId - side chat to carry back.
     * @param {{parentSessionId: string, atSeq: number}} origin - fork origin.
     * @param {{inject?: boolean}} [options] - carry carrier.
     * @returns {Promise<'drafted' | 'sent' | 'injected'>}
     */
    async function carryBack(ctx, childSessionId, origin, options) {
      const answer = await fetchAnswer(childSessionId)
      const selection = selectedText()
      const text = selection === '' ? composeNote(answer.text) : composeQuote(selection)
      const parentSessionId = origin.parentSessionId

      if (options?.inject === true) {
        try {
          await postContext(parentSessionId, text)
          return 'injected'
        } catch {
          // A cold session cannot take context. Degrading is silent on purpose:
          // the button label reports the carrier that actually won.
        }
      }

      const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
      const binding = ctx.sessions.binding(parentSessionId)
      if (conversation?.input !== undefined && binding !== undefined) {
        const result = conversation.input.requestDraftInitialization(binding, {
          prompt: text,
          clearPreviousDraft: false,
        })
        if (result === 'applied') return 'drafted'
      }

      await ctx.sessions.using(parentSessionId, { source: 'sidebarChat' }, async (reference) => {
        const outcome = await reference.binding.session.prompt(
          [{ type: 'text', text }],
          'queue',
        )
        if (outcome?.ok !== true) {
          throw new Error(`prompt was rejected: ${describeResult(outcome)}`)
        }
        return undefined
      })
      return 'sent'
    }

    /**
     * Render a failed remote result as one readable line.
     * @param {unknown} outcome - remote result.
     * @returns {string}
     */
    function describeResult(outcome) {
      const error = outcome?.error
      if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
        return typeof error.message === 'string' ? `${error.code}: ${error.message}` : error.code
      }
      return JSON.stringify(outcome)
    }

    //#endregion

    //#region surface

    /**
     * Right-sidebar tab body: retain the forked session, scope it, render the
     * stock conversation surface inside it.
     * @param {object} props - slot kit.
     * @returns {object | null} React node.
     */
    function SideChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }) {
      const info = useTabInfo()
      const resource = useResource(info.tab.contentId)
      const value = resource.value
      if (value === undefined || value === null) return null
      return jsx('div', {
        className: 'dsc-surface',
        children: jsx(SessionProvider, {
          session: value.reference,
          children: jsx(Fragment, {
            children: renderSlot(SURFACE, {}),
          }),
        }),
      })
    }

    /**
     * Conversation surface for a side chat: same factory as the main window, in
     * its `embedded` variant, pinned to the Chat view.
     * @param {object} props - slot kit.
     * @returns {object} React node.
     */
    function SideChatConversation({
      sessionId,
      useSession,
      useConversation,
      useSessions,
      renderFactorySlot,
    }) {
      const session = useSession((value) => value)
      const active = useConversation((value) => value).activeTargets.size > 0
      const shellPhase =
        active || (!session.blank && !session.awaitingFirstTurn) || session.running
          ? 'active'
          : session.promptAttempted
            ? 'engaging'
            : 'blank'
      const summaryBlank = useSessions((state) => state.byId[sessionId]?.blank)
      const settling =
        shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
      const hero =
        shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
      return renderFactorySlot(
        'conversation.content',
        {
          variant: 'embedded',
          phase: settling ? 'settling' : hero ? 'hero' : 'active',
          hero,
        },
        { slots: { views: SideChatChatView } },
      )
    }

    /**
     * Pin the embedded conversation to the Chat view (no editor / no diff view).
     * @param {object} props - factory slot kit.
     * @returns {object} React node.
     */
    function SideChatChatView(props) {
      return jsx(Fragment, {
        children: props.renderSlot('conversation.session', { view: 'chat' }),
      })
    }

    /**
     * Which message a finished carry reports, per carrier.
     *
     * The carrier is decided at click time and may degrade (context → draft →
     * message), so the label follows the outcome rather than the request.
     */
    const CARRY_LABELS = {
      drafted: 'action.carryDrafted',
      injected: 'action.carryInjected',
      sent: 'action.carrySent',
    }

    /**
     * Per-turn entry point, rendered in the turn footer next to Branch.
     *
     * In the main line it opens a side chat from that turn; inside a side chat
     * it carries this chat's conclusion back into the main line.
     *
     * @param {object} props - slot kit plus the injected action.
     * @returns {object} React node.
     */
    function SideChatTurnAction({ seq, t, mode, run }) {
      const [state, setState] = React.useState('idle')
      const [outcome, setOutcome] = React.useState(undefined)
      const onClick = React.useCallback(
        async (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (state === 'busy') return
          setState('busy')
          setOutcome(undefined)
          try {
            const result = await run(seq, { inject: event.shiftKey === true })
            setOutcome(result)
            setState('done')
          } catch (error) {
            console.error('dsh-side-chat: action failed', error)
            setState('failed')
          }
        },
        [run, seq, state],
      )
      const carrying = mode === 'carry'
      const label =
        state === 'done'
          ? t(CARRY_LABELS[outcome] ?? 'action.carryDrafted')
          : t(carrying ? 'action.carry' : 'action.open')
      const title =
        state === 'failed'
          ? t(carrying ? 'action.carryFailed' : 'action.openFailed')
          : t(carrying ? 'action.carryHint' : 'action.openHint')
      return jsx('button', {
        type: 'button',
        className: 'dsc-turn-action',
        'data-failed': state === 'failed' ? '' : undefined,
        'data-done': state === 'done' ? '' : undefined,
        disabled: state === 'busy',
        title,
        onClick,
        children: [
          jsx('span', {
            key: 'icon',
            className: 'dsc-turn-action-icon',
            'aria-hidden': 'true',
            children: carrying ? '↩' : '◫',
          }),
          jsx('span', { key: 'label', children: label }),
        ],
      })
    }

    //#endregion

    //#region styles

    const STYLE_ID = 'dsh-side-chat-styles'

    const CSS = `
.dsc-surface {
  display: flex;
  flex-direction: column;
  block-size: 100%;
  min-block-size: 0;
}
.dsc-turn-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  opacity: 0.72;
  cursor: pointer;
}
.dsc-turn-action:hover:not(:disabled) {
  background: color-mix(in oklab, currentColor 10%, transparent);
  opacity: 1;
}
.dsc-turn-action:disabled {
  cursor: progress;
  opacity: 0.5;
}
.dsc-turn-action[data-failed] {
  color: var(--dsh-color-danger, #d9534f);
  opacity: 1;
}
.dsc-turn-action-icon {
  font-size: 13px;
  line-height: 1;
}
.dsc-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-inline-size: 0;
}
.dsc-title > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsc-title-dot {
  inline-size: 6px;
  block-size: 6px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0;
  flex: none;
}
.dsc-title-running .dsc-title-dot {
  opacity: 0.8;
  animation: dsc-pulse 1.4s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .dsc-title-running .dsc-title-dot {
    animation: none;
  }
}
@keyframes dsc-pulse {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 0.9;
  }
}
`

    /** Mount the plugin stylesheet once. */
    function mountStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = 'true'
      tag.textContent = CSS
      document.head.append(tag)
    }

    /** Drop the plugin stylesheet. */
    function unmountStyles() {
      document.getElementById(STYLE_ID)?.remove()
    }

    //#endregion

    //#region plugin

    /**
     * Register the side-chat resource type, its sidebar tab, its conversation
     * surface, and the per-turn entry point.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-chat: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.effect(
        () => ctx.resources.register(resourceProvider(ctx.sessions)),
        'side-chat: resource',
      )

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: PLUGIN_ID,
            kind: KIND,
            patterns: [`${PREFIX}**`],
            priority: 'builtin',
            canOpen: (address) => parseAddress(address) !== undefined,
            title: () => t('tab.title'),
          }),
        'side-chat: sidebar type',
      )

      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: PLUGIN_ID,
            children: { [SURFACE]: { kind: 'single', scope: 'session' } },
          },
          SideChatTab,
        ),
      )

      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab.title',
            key: PLUGIN_ID,
            inject: () => ({ sessions: ctx.sessions }),
          },
          SideChatTitle,
        ),
      )

      ctx.slots.inject(SURFACE, () =>
        ctx.slots.register({ name: SURFACE }, SideChatConversation),
      )

      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: PLUGIN_ID,
            locale: NS,
            inject: (sessionId) => {
              const origin = originOf(sessionId)
              if (origin !== undefined) {
                return {
                  mode: 'carry',
                  run: (atSeq, options) => carryBack(ctx, sessionId, origin, options),
                }
              }
              return {
                mode: 'open',
                run: (atSeq) => openSideChat(ctx, sessionId, atSeq),
              }
            },
          },
          SideChatTurnAction,
        ),
      )

      restoreOrigins()
      mountStyles()
      ctx.effect(() => () => unmountStyles(), 'side-chat: styles')
    }

    //#endregion

    //#region live title

    /**
     * Follow one catalog row as it changes.
     *
     * A side chat keeps working while its tab is collapsed or behind another
     * one, so the chip has to say so on its own: the catalog row is the only
     * place that knows, and it is a live snapshot rather than a value.
     *
     * @param {object} list - `sessions.list`, an observable snapshot.
     * @param {string} id - session to follow; empty follows nothing.
     * @returns {object | undefined} the row, or undefined when it is not listed.
     */
    function useSummary(list, id) {
      const subscribe = React.useCallback((notify) => list.subscribe(notify), [list])
      const read = React.useCallback(() => list.getSnapshot().byId[id], [list, id])
      return React.useSyncExternalStore(subscribe, read, read)
    }

    /**
     * Draw one side chat's chip: its captured title, plus a pulse while the
     * side chat is still running.
     * @param {{ useTabInfo: () => object, sessions: object }} props - slot kit plus the injected service.
     * @returns {object} React element.
     */
    function SideChatTitle({ useTabInfo, sessions }) {
      const { tab } = useTabInfo()
      const parsed = parseAddress(tab.navigation.address) ?? parseAddress(String(tab.contentId ?? ''))
      const summary = useSummary(sessions.list, parsed === undefined ? '' : parsed.childSessionId)
      const running = summary !== undefined && summary.running === true
      return jsx('span', {
        className: running ? 'dsc-title dsc-title-running' : 'dsc-title',
        children: [
          jsx('span', { key: 'dot', className: 'dsc-title-dot', 'aria-hidden': 'true' }),
          jsx('span', { key: 'label', children: tab.title }),
        ],
      })
    }

    //#endregion

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
