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
    }

    const en = {
      'tab.title': 'Side chat',
      'action.open': 'Side chat',
      'action.openHint': 'Branch this turn into a side chat on the right; the main line stays untouched',
      'action.openFailed': 'Could not open a side chat — try again',
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
      ctx.sidebarRight.openResource(
        buildAddress(childSessionId, parentSessionId, atSeq),
      )
      return childSessionId
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
     * Per-turn entry point, rendered in the turn footer next to Branch.
     * @param {object} props - slot kit plus the injected opener.
     * @returns {object} React node.
     */
    function SideChatTurnAction({ seq, t, openSideChat }) {
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const onClick = React.useCallback(
        async (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (busy) return
          setBusy(true)
          setFailed(false)
          try {
            await openSideChat(seq)
          } catch (error) {
            console.error('dsh-side-chat: could not open a side chat', error)
            setFailed(true)
          } finally {
            setBusy(false)
          }
        },
        [busy, openSideChat, seq],
      )
      return jsx('button', {
        type: 'button',
        className: 'dsc-turn-action',
        'data-failed': failed ? '' : undefined,
        disabled: busy,
        title: failed ? t('action.openFailed') : t('action.openHint'),
        onClick,
        children: [
          jsx('span', {
            key: 'icon',
            className: 'dsc-turn-action-icon',
            'aria-hidden': 'true',
            children: '◫',
          }),
          jsx('span', { key: 'label', children: t('action.open') }),
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

      ctx.slots.inject(SURFACE, () =>
        ctx.slots.register({ name: SURFACE }, SideChatConversation),
      )

      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: PLUGIN_ID,
            locale: NS,
            inject: (sessionId) => ({
              openSideChat: (atSeq) => openSideChat(ctx, sessionId, atSeq),
            }),
          },
          SideChatTurnAction,
        ),
      )

      mountStyles()
      ctx.effect(() => () => unmountStyles(), 'side-chat: styles')
    }

    //#endregion

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
