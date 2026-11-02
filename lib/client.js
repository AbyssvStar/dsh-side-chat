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
     * @type {Map<string, {parentSessionId: string, atSeq: number | null}>}
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
      'action.carryFailed': '带回失败',
      'action.carryFailedEmpty': '这个侧聊还没有可以带回的结论',
      'action.carryDrafted': '已放进主线输入框',
      'action.carryInjected': '已作为背景放进主线上下文',
      'action.carrySent': '主线的输入框正忙，已作为消息直接发给主线',
      'selection.send': '带去侧聊',
      'selection.hint': '把选中的内容放进侧聊的输入框继续追问',
      'selection.prompt': '关于这段内容：',
      'selection.failed': '没送过去',
      'selection.busy': '侧聊的输入框还没准备好，请重试',
      'selection.noSession': '当前没有打开的会话',
    }

    const en = {
      'tab.title': 'Side chat',
      'action.open': 'Side chat',
      'action.openHint': 'Branch this turn into a side chat on the right; the main line stays untouched',
      'action.openFailed': 'Could not open a side chat — try again',
      'action.carry': 'Carry back',
      'action.carryHint': "Put this side chat's conclusion into the main composer for review before sending; hold Shift to queue it as background context instead",
      'action.carryFailed': 'Carry-back failed',
      'action.carryFailedEmpty': 'this side chat has no answer yet',
      'action.carryDrafted': 'Put into the main composer',
      'action.carryInjected': 'Queued as background context on the main line',
      'action.carrySent': 'The main composer was busy, so it was sent as a message instead',
      'selection.send': 'Ask in side chat',
      'selection.hint': 'Put the highlighted passage into a side chat composer and take it from there',
      'selection.prompt': 'About this passage:',
      'selection.failed': 'Could not send it',
      'selection.busy': 'the side chat composer was not ready yet',
      'selection.noSession': 'no session is open right now',
    }

    //#endregion

    //#region address

    /**
     * Build the resource address of one side-chat tab.
     * @param {string} childSessionId - the forked session.
     * @param {string} parentSessionId - the session the fork came from.
     * @param {number} atSeq - closing seq of the turn the fork was taken from, or null for the latest turn.
     * @returns {string} `dsh-resource://sidechat/session/<child>?parent=…&at=…`
     */
    function buildAddress(childSessionId, parentSessionId, atSeq) {
      const query = new URLSearchParams({ parent: parentSessionId })
      // A side chat started from a selection is forked at whatever turn was
      // latest, so it has no fork point to record.
      if (Number.isFinite(atSeq)) query.set('at', String(atSeq))
      return `${PREFIX}${encodeURIComponent(childSessionId)}?${query.toString()}`
    }

    /**
     * Parse a side-chat address.
     * @param {string} value - candidate address.
     * @returns {{address: string, childSessionId: string, parentSessionId: string, atSeq: number | null} | undefined}
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
      let atSeq = null
      if (atParam !== null && atParam.trim() !== '') {
        const at = Number(atParam)
        if (!Number.isFinite(at)) return undefined
        atSeq = at
      }
      return {
        address: value,
        childSessionId: decodeURIComponent(parts[1]),
        parentSessionId,
        atSeq,
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
      const options = { sessionId: parentSessionId, increaseTitle: false }
      // Omitting `atSeq` asks the host for the latest completed turn.
      if (Number.isFinite(atSeq)) options.atSeq = atSeq
      const childSessionId = await ctx.sessions.fork(options)
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
     * @param {number | null} atSeq - closing seq of the turn, or null when there is none.
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
        if (origin.atSeq !== null && (typeof origin.atSeq !== 'number' || !Number.isFinite(origin.atSeq))) continue
        origins.set(child, { parentSessionId: origin.parentSessionId, atSeq: origin.atSeq })
      }
    }

    /**
     * Where a session was forked from, when this browser opened it as a side chat.
     * @param {string} sessionId - candidate session.
     * @returns {{parentSessionId: string, atSeq: number | null} | undefined}
     */
    function originOf(sessionId) {
      return origins.get(sessionId)
    }

    //#endregion

    //#region carry-back

    /**
     * Explain an answer that carried no body at all.
     *
     * An empty 404 is not a route refusing us: it is the webserver's own
     * fallback saying it never heard of this path, which in practice means the
     * Node process predates the half that registered it.
     *
     * @param {number} status - HTTP status of an empty response.
     * @returns {string} text for the failure message.
     */
    function emptyBodyDetail(status) {
      const base = `HTTP ${status} with an empty body`
      return status === 404 ? `${base} — the host half of dsh-side-chat may not be running; restart dsh web` : base
    }

    /**
     * Turn a host reply into its JSON body, or into a reason a user can act on.
     *
     * A route that is not there answers with an empty 404, and the first version
     * of this code surfaced that as `Unexpected end of JSON input`, which says
     * nothing about what went wrong. The status and the body head travel in the
     * message instead, so the button's tooltip is a diagnosis.
     *
     * @param {object} response - fetch response.
     * @param {string} what - the operation, for the message.
     * @returns {Promise<any>} the parsed body of a successful reply.
     */
    async function readReply(response, what) {
      const raw = await response.text()
      let body
      if (raw !== '') {
        try {
          body = JSON.parse(raw)
        } catch {
          body = undefined
        }
      }
      if (response.ok !== true || body?.ok !== true) {
        const detail =
          typeof body?.error === 'string'
            ? body.error
            : raw === ''
              ? emptyBodyDetail(response.status)
              : `HTTP ${response.status}: ${raw.slice(0, 200)}`
        throw new Error(`${what}: ${detail}`)
      }
      return body
    }

    /**
     * Ask the host for a side chat's newest answer text.
     *
     * The parent travels with the request because the host proves ownership
     * before it reads: a session id alone is not a licence to read its prose.
     *
     * @param {string} childSessionId - side chat to read.
     * @param {string} parentSessionId - session this side chat was forked from.
     * @returns {Promise<{text: string, turn: number | null}>}
     */
    async function fetchAnswer(childSessionId, parentSessionId) {
      const url = `${HANDOFF_URL}?child=${encodeURIComponent(childSessionId)}&parent=${encodeURIComponent(parentSessionId)}`
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      const body = await readReply(response, 'carry-back')
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
     * Wrap a highlighted passage as a question for a side chat.
     * @param {string} text - selected passage.
     * @param {Function} t - locale lookup.
     * @returns {string} composer text.
     */
    function composeAsk(text, t) {
      return `${t('selection.prompt')}

${text.trim()}`
    }

    /**
     * Put a passage into the composer of the side chat on screen, or of a new one.
     *
     * The passage goes to the draft rather than straight out: the user asked to
     * move text, not to ask a question, so they finish the sentence.
     *
     * @param {object} ctx - client root context.
     * @param {string} text - selected passage.
     * @param {Function} t - locale lookup.
     * @returns {Promise<string>} the side chat that received it.
     */
    async function sendSelectionToSideChat(ctx, text, t) {
      const sessionId = ctx.sidebarRight?.mounted?.getSnapshot?.()
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new Error(t('selection.noSession'))
      }
      const open = typeof ctx.sidebarRight.tabsIn === 'function' ? ctx.sidebarRight.tabsIn(sessionId) : []
      const mine = (open ?? []).filter((tab) => tab?.kind === KIND)
      const active = typeof ctx.sidebarRight.active === 'function' ? ctx.sidebarRight.active() : undefined
      const target = mine.find((tab) => active !== undefined && tab.id === active.id) ?? mine[mine.length - 1]
      let childSessionId =
        target === undefined ? '' : parseAddress(String(target.navigation?.address ?? ''))?.childSessionId ?? ''
      if (childSessionId === '') {
        childSessionId = await openSideChat(ctx, sessionId, null)
      } else {
        ctx.sidebarRight.focus?.(target.id)
      }
      const prompt = composeAsk(text, t)
      if (await draftInto(ctx, childSessionId, prompt)) return childSessionId
      throw new Error(t('selection.busy'))
    }

    /**
     * Write into one session's composer, retrying while its body mounts.
     *
     * A tab opened a moment ago has no composer yet, and
     * `requestDraftInitialization` answers `blocked` for a session that is not
     * currently retained by a mounted scope. Retrying briefly is the difference
     * between "sent it" and "nothing happened".
     *
     * @param {object} ctx - client root context.
     * @param {string} childSessionId - side chat whose composer should take the text.
     * @param {string} prompt - composer text.
     * @returns {Promise<boolean>} whether the draft landed.
     */
    async function draftInto(ctx, childSessionId, prompt) {
      const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
      const input = conversation?.input
      if (input === undefined) return false
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const binding = ctx.sessions.binding(childSessionId)
          const outcome = await input.requestDraftInitialization(binding, { prompt, clearPreviousDraft: false })
          if (outcome === 'applied') return true
        } catch {
          // The tab body is still mounting; try again below.
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      return false
    }

    /**
     * Offer "send this passage to a side chat" next to any text selection.
     *
     * Selection is a document-level fact, so this is a document-level widget
     * rather than a slot: it has to work over the main line, over tool output,
     * and over a side chat's own transcript. A selection made *inside* a side
     * chat is ignored, since sending a side chat its own text is not a move.
     *
     * @param {object} ctx - client root context.
     * @param {Function} t - locale lookup.
     * @returns {Function} disposer.
     */
    function startSelectionHelper(ctx, t) {
      const doc = globalThis.document
      if (doc === undefined || typeof doc.createElement !== 'function' || typeof globalThis.getSelection !== 'function') {
        return () => {}
      }
      const button = doc.createElement('button')
      button.type = 'button'
      button.className = 'dsc-selection'
      button.setAttribute('data-dsc-own', '')
      button.title = t('selection.hint')
      button.hidden = true
      // An author rule that lays the button out beats the user agent's
      // `[hidden] { display: none }`, so the attribute alone would leave the
      // button on screen after the selection is gone. `display` is the thing
      // the browser actually obeys here.
      button.style.display = 'none'
      const icon = doc.createElement('span')
      icon.className = 'dsc-selection-icon'
      icon.setAttribute('aria-hidden', 'true')
      icon.textContent = '↪'
      const label = doc.createElement('span')
      label.textContent = t('selection.send')
      button.append(icon, label)
      doc.body.append(button)

      let text = ''
      const hide = () => {
        button.hidden = true
        button.style.display = 'none'
        text = ''
      }
      const place = () => {
        const selection = globalThis.getSelection()
        if (selection === null || selection === undefined || selection.isCollapsed === true) return hide()
        const value = typeof selection.toString === 'function' ? selection.toString().trim() : ''
        if (value === '') return hide()
        const anchor = selection.anchorNode
        const element = anchor === null || anchor === undefined ? null : anchor.nodeType === 1 ? anchor : anchor.parentElement
        if (element !== null && typeof element?.closest === 'function' && element.closest('.dsc-surface, [data-dsc-own]') !== null) {
          return hide()
        }
        text = value.length > MAX_SELECTION ? value.slice(0, MAX_SELECTION) : value
        let rect
        try {
          rect = selection.getRangeAt(0).getBoundingClientRect()
        } catch {
          return hide()
        }
        button.hidden = false
        button.style.display = 'inline-flex'
        const width = button.offsetWidth || 96
        const height = button.offsetHeight || 28
        const viewportWidth = globalThis.innerWidth || 1024
        const viewportHeight = globalThis.innerHeight || 768
        const left = Math.min(Math.max(8, rect.right - width), viewportWidth - width - 8)
        const below = rect.bottom + 6
        const top = below + height > viewportHeight ? Math.max(8, rect.top - height - 6) : below
        button.style.left = `${Math.round(left)}px`
        button.style.top = `${Math.round(top)}px`
      }
      const schedule = () => {
        if (typeof globalThis.requestAnimationFrame === 'function') {
          globalThis.requestAnimationFrame(place)
        } else {
          setTimeout(place, 0)
        }
      }

      let busy = false
      const onClick = async (event) => {
        event.preventDefault()
        if (busy || text === '') return
        busy = true
        button.disabled = true
        try {
          await sendSelectionToSideChat(ctx, text, t)
          hide()
        } catch (error) {
          console.error('dsh-side-chat: selection failed', error)
          button.title = `${t('selection.failed')} — ${error instanceof Error ? error.message : String(error)}`
        } finally {
          busy = false
          button.disabled = false
        }
      }
      // Keep the selection alive: a mousedown that moves focus would collapse it.
      const onMouseDown = (event) => event.preventDefault()

      doc.addEventListener('selectionchange', schedule)
      doc.addEventListener('mouseup', schedule)
      globalThis.addEventListener?.('scroll', hide, true)
      button.addEventListener('mousedown', onMouseDown)
      button.addEventListener('click', onClick)

      return () => {
        doc.removeEventListener('selectionchange', schedule)
        doc.removeEventListener('mouseup', schedule)
        globalThis.removeEventListener?.('scroll', hide, true)
        button.removeEventListener('mousedown', onMouseDown)
        button.removeEventListener('click', onClick)
        button.remove()
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
     * @param {string} parentSessionId - side chat this note came from, for provenance.
     * @returns {Promise<void>} resolves once the host accepted the note.
     */
    async function postContext(sessionId, text, parentSessionId) {
      const response = await fetch(CONTEXT_URL, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        // The marker is what forces a cross-site caller into a preflight this
        // server never grants; without it the host refuses the write.
        headers: { 'Content-Type': 'application/json', 'X-Side-Chat': '1' },
        body: JSON.stringify({ sessionId, text, parent: parentSessionId }),
      })
      await readReply(response, 'context injection')
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
     * @param {{parentSessionId: string, atSeq: number | null}} origin - fork origin.
     * @param {{inject?: boolean}} [options] - carry carrier.
     * @returns {Promise<'drafted' | 'sent' | 'injected'>}
     */
    async function carryBack(ctx, childSessionId, origin, options) {
      const parentSessionId = origin.parentSessionId
      const answer = await fetchAnswer(childSessionId, parentSessionId)
      const selection = selectedText()
      const text = selection === '' ? composeNote(answer.text) : composeQuote(selection)

      if (options?.inject === true) {
        try {
          await postContext(parentSessionId, text, childSessionId)
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
      const [failure, setFailure] = React.useState('')
      const onClick = React.useCallback(
        async (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (state === 'busy') return
          setState('busy')
          setOutcome(undefined)
          setFailure('')
          try {
            const result = await run(seq, { inject: event.shiftKey === true })
            setOutcome(result)
            setState('done')
          } catch (error) {
            // The reason has to reach the user: a failed carry is otherwise
            // indistinguishable from a button that does nothing.
            console.error('dsh-side-chat: action failed', error)
            setFailure(error instanceof Error ? error.message : String(error))
            setState('failed')
          }
        },
        [run, seq, state],
      )
      const carrying = mode === 'carry'
      const label =
        state === 'done'
          ? t(CARRY_LABELS[outcome] ?? 'action.carryDrafted')
          : state === 'failed'
            ? t(carrying ? 'action.carryFailed' : 'action.openFailed')
            : t(carrying ? 'action.carry' : 'action.open')
      const reason =
        state === 'failed'
          ? t(carrying ? 'action.carryFailedEmpty' : 'action.openFailed')
          : t(carrying ? 'action.carryHint' : 'action.openHint')
      const title = failure === '' ? reason : `${reason} — ${failure}`
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
.dsc-selection {
  position: fixed;
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-default, #3a3f4b);
  border-radius: 6px;
  background: var(--dsw-alias-bg-elevated, #22262e);
  color: var(--dsw-alias-text-default, #e6e8ee);
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  box-shadow: 0 4px 14px rgb(0 0 0 / 28%);
}

.dsc-selection[hidden] {
  display: none;
}

.dsc-selection:hover:not(:disabled) {
  background: var(--dsw-alias-bg-hover, #2c313b);
}

.dsc-selection:disabled {
  opacity: 0.55;
  cursor: progress;
}

.dsc-selection-icon {
  font-size: 13px;
  line-height: 1;
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
      ctx.effect(() => startSelectionHelper(ctx, t), 'side-chat: selection helper')
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
