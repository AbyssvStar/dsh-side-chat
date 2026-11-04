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
      'uiWorkspace',
    ]

    //#endregion

    //#region dictionary

    const zh = {
      'tab.title': '侧聊',
      'chat.prefix': '侧聊 · ',
      'guide.branchTitle': '侧聊 · 接着主线',
      'guide.branchDescription': '从主线最新一轮分出一条，原地追问，主线不受影响',
      'guide.blankTitle': '侧聊 · 空白',
      'guide.blankDescription': '不带任何上下文，直接开一个在旁边问',
      'close.archiveTitle': '关闭侧聊',
      'close.archivePrompt': '这个侧聊已经关掉了。要顺手归档吗？归档后它就不再占着会话列表。',
      'close.archive': '归档',
      'close.keep': '留着',
      'close.archived': '已归档',
      'carry.summaryPrompt': [
        '把刚才这段对话的结论整理成一小段可以直接带回主线的文字。',
        '只留结论、决定，以及主线需要知道的约束和坑；不要复述过程，不要客套，不要标题和列表。',
        '直接给正文，尽量三百字以内。',
      ].join('\n'),
      'action.open': '侧聊',
      'action.openHint': '从这一轮分出一条侧聊，在右侧栏继续聊；主线不受影响',
      'action.openFailed': '侧聊创建失败，请重试',
      'action.carry': '带回主线',
      'action.carryHint': '先让侧聊把结论总结成一段，再放进主线的输入框，由你决定发不发；按住 Shift 则作为背景放进主线上下文，同样不会让它自己跑',
      'action.carryFailed': '带回失败',
      'action.carryFailedEmpty': '这个侧聊还没有可以带回的结论',
      'action.carryDrafted': '已放进主线输入框',
      'action.carryInjected': '已作为背景放进主线上下文',
      'action.summarizing': '正在总结…',
      'action.carryNoComposer': '主线的输入框没准备好，先切回主线再点一次',
      'selection.send': '带去侧聊',
      'selection.hint': '把选中的内容放进侧聊的输入框继续追问',
      'selection.prompt': '关于这段内容：',
      'selection.failed': '没送过去',
      'selection.busy': '侧聊的输入框还没准备好，请重试',
      'selection.noSession': '当前没有打开的会话',
    }

    const en = {
      'tab.title': 'Side chat',
      'chat.prefix': 'Side chat · ',
      'guide.branchTitle': 'Side chat · follow the main line',
      'guide.branchDescription': 'Branch the latest turn and keep asking beside it; the main line stays untouched',
      'guide.blankTitle': 'Side chat · blank',
      'guide.blankDescription': 'Start one with no context carried over',
      'close.archiveTitle': 'Close side chat',
      'close.archivePrompt': 'This side chat is closed. Archive it as well? Archived sessions stop taking up room in the conversation list.',
      'close.archive': 'Archive',
      'close.keep': 'Keep',
      'close.archived': 'Archived',
      'carry.summaryPrompt': [
        'Condense this conversation into a short passage that can be carried back to the main line.',
        'Keep only the conclusion, the decisions, and any constraint or trap the main line needs to know.',
        'Do not retell the process, do not add pleasantries, no headings or bullet lists.',
        'Reply with the passage itself, ideally under 300 words.',
      ].join('\n'),
      'action.open': 'Side chat',
      'action.openHint': 'Branch this turn into a side chat on the right; the main line stays untouched',
      'action.openFailed': 'Could not open a side chat — try again',
      'action.carry': 'Carry back',
      'action.carryHint': "Summarise this side chat, then put the conclusion into the main composer for you to send; hold Shift to queue it as background context instead — neither one starts a turn",
      'action.carryFailed': 'Carry-back failed',
      'action.carryFailedEmpty': 'this side chat has no answer yet',
      'action.carryDrafted': 'Put into the main composer',
      'action.carryInjected': 'Queued as background context on the main line',
      'action.summarizing': 'Summarising…',
      'action.carryNoComposer': 'the main composer was not ready — switch to the main line and try again',
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
     * @param {string} childSessionId - the forked (or freshly created) session.
     * @param {string | undefined} parentSessionId - the session it came from; absent for a blank side chat.
     * @param {number | null} atSeq - closing seq of the turn the fork was taken from, or null for the latest turn.
     * @returns {string} `dsh-resource://sidechat/session/<child>?parent=…&at=…`
     */
    function buildAddress(childSessionId, parentSessionId, atSeq) {
      const query = new URLSearchParams()
      if (typeof parentSessionId === 'string' && parentSessionId !== '') {
        query.set('parent', parentSessionId)
      }
      // A side chat started from a selection is forked at whatever turn was
      // latest, so it has no fork point to record.
      if (Number.isFinite(atSeq)) query.set('at', String(atSeq))
      const suffix = query.toString()
      return `${PREFIX}${encodeURIComponent(childSessionId)}${suffix === '' ? '' : `?${suffix}`}`
    }

    /**
     * Parse a side-chat address.
     * @param {string} value - candidate address.
     * @returns {{address: string, childSessionId: string, parentSessionId: string | null, atSeq: number | null} | undefined}
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
      const parentParam = url.searchParams.get('parent')
      const atParam = url.searchParams.get('at')
      let atSeq = null
      if (atParam !== null && atParam.trim() !== '') {
        const at = Number(atParam)
        if (!Number.isFinite(at)) return undefined
        atSeq = at
      }
      return {
        address: value,
        childSessionId: decodeURIComponent(parts[1]),
        // A blank side chat has no origin; the address simply omits it.
        parentSessionId: parentParam === null || parentParam === '' ? null : parentParam,
        atSeq,
      }
    }

    //#endregion

    //#region address lookup

    /**
     * The side chat a sidebar tab is showing.
     *
     * A resource tab keeps its address under `navigation`, while a tab restored
     * from a saved layout may only carry the content id; both spell the same
     * address, so try both before giving up.
     *
     * @param {object} tab - the tab record handed to a close handler.
     * @returns {{childSessionId: string, parentSessionId: string, atSeq: number | null} | undefined}
     */
    function addressOf(tab) {
      const fromNavigation = parseAddress(String(tab?.navigation?.address ?? ''))
      if (fromNavigation !== undefined) return fromNavigation
      return parseAddress(String(tab?.contentId ?? ''))
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
     * @param {(key: string) => string} [t] - dictionary lookup for the tab title.
     * @returns {Promise<string>} the forked session id.
     */
    async function openSideChat(ctx, parentSessionId, atSeq, t) {
      const options = { sessionId: parentSessionId, increaseTitle: false }
      // Omitting `atSeq` asks the host for the latest completed turn.
      if (Number.isFinite(atSeq)) options.atSeq = atSeq
      const childSessionId = await ctx.sessions.fork(options)
      rememberOrigin(childSessionId, parentSessionId, atSeq)
      ctx.sidebarRight.openResource(
        buildAddress(childSessionId, parentSessionId, atSeq),
      )
      // Fire and forget: a title is cosmetic, the tab is already open.
      void labelSideChat(ctx, childSessionId, t)
      return childSessionId
    }

    /**
     * Open a side chat that carries nothing over from the main line.
     *
     * Not every question beside your work is a follow-up: sometimes it is "what
     * does this regex do", and paying for the main line's history — and letting
     * it shape the answer — is wrong. A blank side chat is an ordinary new
     * session placed in the sidebar: it has no origin, no carry-back button, and
     * no relationship with the line it was opened from beyond the directory the
     * two share.
     *
     * @param {object} ctx - client root context.
     * @param {string | undefined} cwd - directory to start in, normally the current session's.
     * @param {(key: string) => string} [t] - dictionary lookup for the tab title.
     * @returns {Promise<string>} the created session id.
     */
    async function openBlankSideChat(ctx, cwd, t) {
      const options = typeof cwd === 'string' && cwd !== '' ? { cwd } : {}
      const childSessionId = await ctx.sessions.create(options)
      ctx.sidebarRight.openResource(buildAddress(childSessionId, undefined, null))
      void labelSideChat(ctx, childSessionId, t)
      return childSessionId
    }

    /**
     * Give a fresh fork a title that says what it is.
     *
     * A fork inherits its parent's title verbatim, so the session list fills up
     * with rows that are impossible to tell apart. Stamping the moment the side
     * chat was branched makes each row distinguishable at a glance. The rename is
     * best effort: a side chat that keeps the inherited title still works.
     *
     * @param {object} ctx - client root context.
     * @param {string} childSessionId - the forked session.
     * @param {(key: string) => string} [t] - dictionary lookup for the prefix.
     * @returns {Promise<void>} resolves whether or not the rename landed.
     */
    async function labelSideChat(ctx, childSessionId, t) {
      // A fork copies its parent's durable title, so a handful of side chats fills
      // the list with identical rows. `sessions.using` is the supported way to
      // reach a session handle (`binding.session`), and that handle is what owns
      // `rename`; there is no service-level rename to call instead.
      if (typeof ctx.sessions.using !== 'function') return
      const prefix = typeof t === 'function' ? t('chat.prefix') : 'Side chat · '
      const title = `${prefix}${clockLabel(new Date())}`
      try {
        await ctx.sessions.using(childSessionId, { source: 'sidebarChat' }, async (reference) => {
          const session = reference?.binding?.session
          if (typeof session?.rename !== 'function') return undefined
          const result = await session.rename(title)
          if (result?.ok !== true) console.warn('dsh-side-chat: rename failed', result)
          return undefined
        })
      } catch (error) {
        // A title is cosmetic: never let it fail the open.
        console.warn('dsh-side-chat: rename failed', error)
      }
    }

    /**
     * Render a wall-clock moment as `MM-DD HH:mm`, the smallest stamp that stays
     * readable in a narrow session row.
     * @param {Date} moment - when the side chat was branched.
     * @returns {string} the stamp.
     */
    function clockLabel(moment) {
      const pad = (value) => String(value).padStart(2, '0')
      const date = `${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`
      return `${date} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`
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
     *
     * The forward map only knows side chats this browser opened. Any other fork —
     * one made by the built-in Branch command, or one this browser opened before
     * the map existed — is still a fork, and its catalog row names the parent:
     * that is enough to offer `carry back`, which is what the user wanted from
     * the row in the first place. Subagent children are excluded: their parent
     * line is a delegation, not a conversation that could take a conclusion back.
     *
     * @param {object} ctx - client root context.
     * @param {string} sessionId - candidate session.
     * @returns {{parentSessionId: string, atSeq: number | null} | undefined}
     */
    function originOf(ctx, sessionId) {
      const known = origins.get(sessionId)
      if (known !== undefined) return known
      const summary = ctx.sessions.list?.getSnapshot()?.byId?.[sessionId]
      if (summary === undefined || summary === null) return undefined
      if (summary.origin === 'subagent') return undefined
      if (typeof summary.parentSessionId !== 'string' || summary.parentSessionId === '') return undefined
      return { parentSessionId: summary.parentSessionId, atSeq: null }
    }

    //#endregion

    //#region retirement

    /** The archive question currently on screen, if any. */
    let archivePrompt

    /**
     * Take down whatever archive question is on screen.
     *
     * Two closes in a row must not stack two questions about two different
     * sessions on top of each other: the second one wins, and the first is
     * simply dropped unanswered (which means "keep").
     */
    function dismissArchivePrompt() {
      if (archivePrompt === undefined) return
      const open = archivePrompt
      archivePrompt = undefined
      open()
    }

    /**
     * Ask, in the sidebar's own idiom, whether a closed side chat should be archived.
     *
     * `window.confirm` blocks the whole page and looks like a browser warning; a
     * panel that belongs to the sidebar keeps the question where the thing being
     * decided lives. The tab is already gone by the time the close handler runs,
     * so this is an offer about a closed chat, not a veto: ignoring it keeps the
     * session exactly where it was.
     *
     * @param {(key: string) => string} t - dictionary lookup.
     * @param {(choice: 'archive' | 'keep') => void} decide - called once, with the answer.
     * @returns {void}
     */
    function askArchive(t, decide) {
      const doc = globalThis.document
      if (doc === undefined || typeof doc.createElement !== 'function') {
        decide('keep')
        return
      }
      dismissArchivePrompt()
      const card = doc.createElement('div')
      card.className = 'dsc-dialog'
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-modal', 'false')
      card.setAttribute('data-dsc-own', '')
      const title = doc.createElement('p')
      title.className = 'dsc-dialog-title'
      title.textContent = t('close.archiveTitle')
      const body = doc.createElement('p')
      body.className = 'dsc-dialog-body'
      body.textContent = t('close.archivePrompt')
      const actions = doc.createElement('div')
      actions.className = 'dsc-dialog-actions'
      const keep = doc.createElement('button')
      keep.type = 'button'
      keep.className = 'dsc-dialog-button'
      keep.textContent = t('close.keep')
      const archive = doc.createElement('button')
      archive.type = 'button'
      archive.className = 'dsc-dialog-button dsc-dialog-primary'
      archive.textContent = t('close.archive')
      actions.append(keep, archive)
      card.append(title, body, actions)

      let settled = false
      const close = () => {
        if (settled) return
        settled = true
        doc.removeEventListener('keydown', onKey, true)
        card.remove()
        if (archivePrompt === close) archivePrompt = undefined
      }
      const choose = (choice) => {
        // A replaced card keeps its buttons; they must not answer for a
        // question that is no longer on screen.
        if (settled) return
        close()
        decide(choice)
      }
      const onKey = (event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        choose('keep')
      }
      keep.addEventListener('click', () => choose('keep'))
      archive.addEventListener('click', () => choose('archive'))
      doc.addEventListener('keydown', onKey, true)
      doc.body.append(card)
      archivePrompt = close
      // The question has to be answerable from the keyboard alone.
      archive.focus()
    }

    /**
     * Offer to archive the side chat whose tab was just closed.
     *
     * A side chat is a real session, and a fork never disappears on its own: every
     * one the user is done with stays in the workspace list and buries the
     * conversations they come back to. Closing the tab is the one moment they have
     * clearly stopped using it, so that is when we ask. Declining leaves the
     * session exactly where it was.
     *
     * @param {object} ctx - client root context.
     * @param {string} childSessionId - the side chat whose tab was closed.
     * @param {(key: string) => string} [t] - dictionary lookup for the question.
     * @returns {void}
     */
    function retireSideChat(ctx, childSessionId, t) {
      const ask = typeof t === 'function' ? t : (key) => key
      askArchive(ask, (choice) => {
        if (choice !== 'archive') return
        if (typeof ctx.uiWorkspace?.archiveSession !== 'function') return
        void ctx.uiWorkspace.archiveSession(childSessionId, { stopActivity: true }).catch((error) => {
          console.warn('dsh-side-chat: archive failed', error)
        })
      })
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

    /** How long a side chat gets to answer the summarise request before we carry what is already there. */
    const SUMMARY_TIMEOUT_MS = 120000

    /** How often the carry-back looks for the summary while the side chat writes it. */
    const SUMMARY_POLL_MS = 1500

    /**
     * Wait a while without a timer dependency.
     * @param {number} ms - how long.
     * @returns {Promise<void>}
     */
    function sleep(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms)
      })
    }

    /**
     * Whether a session is mid-turn right now.
     *
     * The catalog row is the only running indicator the client has, and it is
     * what the sidebar title pulses off, so the same source decides when a
     * summary is finished.
     *
     * @param {object} ctx - client root context.
     * @param {string} sessionId - session to inspect.
     * @returns {boolean}
     */
    function isRunning(ctx, sessionId) {
      const row = ctx.sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
      return row?.running === true
    }

    /**
     * Ask a side chat to condense itself, and wait for the condensed answer.
     *
     * A long side chat is a bad thing to paste into a main line: the reasoning
     * that got there is already spent, and only the conclusion still matters.
     * So the carry is two steps — the side chat writes the conclusion, then that
     * conclusion travels. The extra turn is visible in the side chat on purpose;
     * it is the model's own summary, not the plugin's.
     *
     * @param {object} ctx - client root context.
     * @param {string} childSessionId - side chat to condense.
     * @param {string} parentSessionId - session it was forked from, for the host's ownership check.
     * @param {string} before - the answer that was there before asking, so the poll waits for a new one.
     * @param {object} t - locale lookup.
     * @returns {Promise<string | undefined>} the summary, or undefined when none arrived in time.
     */
    async function summarize(ctx, childSessionId, parentSessionId, before, t) {
      await ctx.sessions.using(childSessionId, { source: 'sidebarChat' }, async (reference) => {
        const outcome = await reference.binding.session.prompt(
          [{ type: 'text', text: t('carry.summaryPrompt') }],
          'queue',
        )
        if (outcome?.ok !== true) {
          throw new Error(`the side chat refused to summarise: ${describeResult(outcome)}`)
        }
        return undefined
      })
      const deadline = Date.now() + SUMMARY_TIMEOUT_MS
      while (Date.now() < deadline) {
        await sleep(SUMMARY_POLL_MS)
        if (isRunning(ctx, childSessionId)) continue
        const answer = await fetchAnswer(childSessionId, parentSessionId).catch((error) => {
          console.warn('dsh-side-chat: summary not readable yet', error)
          return undefined
        })
        if (answer !== undefined && answer.text.trim() !== '' && answer.text !== before) return answer.text
      }
      console.warn('dsh-side-chat: the summarise turn did not finish in time; carrying the last answer instead')
      return undefined
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
     * Carry a side chat's conclusion back into the main line.
     *
     * Two carriers, and neither of them wakes the model: the parent's draft,
     * which the user reviews and sends themselves, and — with Shift — the
     * parent's model-facing context, which waits for the next turn instead of
     * starting one. An earlier version fell back to submitting a message when
     * the composer was unavailable, which started a turn the user never asked
     * for; that fallback is gone on purpose, and a carry that cannot land says
     * so instead of speaking on the user's behalf.
     *
     * What travels is the side chat's own summary of itself, not the raw last
     * answer: the reasoning that led somewhere is spent by the time it matters.
     * A highlighted passage overrides the summary — carrying back while text is
     * selected means that text.
     *
     * @param {object} ctx - client root context.
     * @param {string} childSessionId - side chat to carry back.
     * @param {{parentSessionId: string, atSeq: number | null}} origin - fork origin.
     * @param {{inject?: boolean}} [options] - carry carrier.
     * @param {object} t - locale lookup.
     * @returns {Promise<'drafted' | 'injected'>}
     */
    async function carryBack(ctx, childSessionId, origin, options, t) {
      const parentSessionId = origin.parentSessionId
      const selection = selectedText()
      let text
      if (selection !== '') {
        text = composeQuote(selection)
      } else {
        const answer = await fetchAnswer(childSessionId, parentSessionId)
        const summary = await summarize(ctx, childSessionId, parentSessionId, answer.text, t)
        text = composeNote(summary ?? answer.text)
      }

      if (options?.inject === true) {
        await postContext(parentSessionId, text, childSessionId)
        return 'injected'
      }

      const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined
      const binding = ctx.sessions.binding?.(parentSessionId)
      if (conversation?.input !== undefined && binding !== undefined) {
        // The resolver throws when the binding is not the retained generation
        // (the main line was switched away, or reloaded while the tab stayed).
        // Report that instead of routing around it with a message.
        try {
          const result = conversation.input.requestDraftInitialization(binding, {
            prompt: text,
            clearPreviousDraft: false,
          })
          if (result === 'applied') return 'drafted'
        } catch (error) {
          console.warn('dsh-side-chat: draft init failed', error)
        }
      }
      throw new Error(t('action.carryNoComposer'))
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
     * The user picks the carrier with the modifier key, and there is no silent
     * degradation any more: a carry either lands in the composer or arrives as
     * background context, and anything else is reported as a failure instead of
     * being turned into a message the user never wrote.
     */
    const CARRY_LABELS = {
      drafted: 'action.carryDrafted',
      injected: 'action.carryInjected',
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
            : state === 'busy' && carrying
              ? t('action.summarizing')
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

    /**
     * The right sidebar's own door into a side chat.
     *
     * The empty right column already lists every tab type as an entry capsule
     * (terminal, files, previews). Side chat belongs in that row: the user asked
     * for it next to the terminal workspace, so that a question can start in the
     * split without a trip through a turn footer first.
     *
     * Two capsules, because the two questions are different. Following the main
     * line is the default and inherits the conversation up to now; a blank one
     * is for everything else, and inherits nothing.
     *
     * @param {object} props - slot kit (the entry's own title and description) plus the injected launchers.
     * @returns {object} React node.
     */
    function SideChatGuide({ t, entryId, title, description, openNew, openBlank }) {
      const [state, setState] = React.useState('idle')
      const blank = entryId === 'blank'
      const launch = blank ? openBlank : openNew
      const onPick = React.useCallback(async () => {
        if (state === 'busy') return
        setState('busy')
        try {
          // No fork point: the host picks the latest completed turn.
          await launch()
          setState('idle')
        } catch (error) {
          console.error('dsh-side-chat: open failed', error)
          setState('failed')
        }
      }, [launch, state])
      const body = state === 'failed' ? t('action.openFailed') : description
      return jsx('button', {
        type: 'button',
        className: 'dsc-guide-entry',
        'data-sidebar-right-guide-entry': blank ? `${KIND}-blank` : KIND,
        'data-failed': state === 'failed' ? '' : undefined,
        disabled: state === 'busy',
        title: body,
        onClick: onPick,
        children: [
          jsx('span', {
            key: 'icon',
            className: 'dsc-guide-entry-icon',
            'aria-hidden': 'true',
            children: '◫',
          }),
          jsx('span', {
            key: 'text',
            className: 'dsc-guide-entry-text',
            children: [
              jsx('span', { key: 'title', className: 'dsc-guide-entry-title', children: title }),
              jsx('span', {
                key: 'description',
                className: 'dsc-guide-entry-description',
                children: body,
              }),
            ],
          }),
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
.dsc-guide-entry {
  display: flex;
  align-items: center;
  gap: 14px;
  box-sizing: border-box;
  inline-size: 100%;
  min-block-size: 56px;
  padding: 14px 20px;
  border: 0.5px solid var(--dsw-alias-border-l3, #3a3f4b);
  border-radius: var(--dsl-guide-entry-radius, 12px);
  background: var(--dsw-alias-bg-layer-1, #22262e);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.dsc-guide-entry:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, #2c313b);
}
.dsc-guide-entry:disabled {
  cursor: progress;
  opacity: 0.72;
}
.dsc-guide-entry[data-failed] {
  color: var(--dsh-color-danger, #d9534f);
}
.dsc-guide-entry-icon {
  flex: none;
  inline-size: 26px;
  font-size: 20px;
  line-height: 1;
  text-align: center;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dsc-guide-entry-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-inline-size: 0;
}
.dsc-guide-entry-title {
  font-size: 14px;
  line-height: 1.4;
}
.dsc-guide-entry-description {
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 11px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsc-dialog {
  position: fixed;
  z-index: 70;
  inset-inline-end: 20px;
  inset-block-end: 20px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  inline-size: 320px;
  max-inline-size: calc(100vw - 40px);
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l3, #3a3f4b);
  border-radius: var(--dsw-radius-xl, 14px);
  background: var(--dsw-alias-bg-layer-1, #22262e);
  color: var(--dsw-alias-label-primary, #e6e8ee);
  box-shadow: 0 10px 30px rgb(0 0 0 / 32%);
  font: inherit;
}
.dsc-dialog-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.dsc-dialog-body {
  margin: 0;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.5;
}
.dsc-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-block-start: 4px;
}
.dsc-dialog-button {
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-border-l3, #3a3f4b);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsc-dialog-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, #2c313b);
}
.dsc-dialog-primary {
  border-color: var(--dsw-alias-brand-primary, #4d7cfe);
  background: var(--dsw-alias-brand-primary, #4d7cfe);
  color: #fff;
}
.dsc-dialog-primary:hover {
  background: var(--dsw-alias-brand-primary-hover, #5f8aff);
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
            guide: [
              {
                id: 'branch',
                order: 10,
                title: () => t('guide.branchTitle'),
                description: () => t('guide.branchDescription'),
              },
              {
                id: 'blank',
                order: 20,
                title: () => t('guide.blankTitle'),
                description: () => t('guide.blankDescription'),
              },
            ],
          }),
        'side-chat: sidebar type',
      )

      ctx.slots.inject('sidebar.right.tab.guide.entry', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.tab.guide.entry',
            key: PLUGIN_ID,
            locale: NS,
            inject: (sessionId) => ({
              openNew: (atSeq) => openSideChat(ctx, sessionId, atSeq, t),
              openBlank: () =>
                openBlankSideChat(ctx, ctx.sessions.list?.getSnapshot()?.byId?.[sessionId]?.cwd, t),
            }),
          },
          SideChatGuide,
        ),
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
              const origin = originOf(ctx, sessionId)
              if (origin !== undefined) {
                return {
                  mode: 'carry',
                  run: (atSeq, options) => carryBack(ctx, sessionId, origin, options, t),
                }
              }
              return {
                mode: 'open',
                run: (atSeq) => openSideChat(ctx, sessionId, atSeq, t),
              }
            },
          },
          SideChatTurnAction,
        ),
      )

      ctx.effect(
        () =>
          ctx.sidebarRight.registerCloseHandler(KIND, (sessionId, tab) => {
            const parsed = addressOf(tab)
            if (parsed === undefined) return
            void retireSideChat(ctx, parsed.childSessionId, t)
          }),
        'side-chat: close handler',
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
