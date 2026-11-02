/**
 * Host half of dsh-side-chat.
 *
 * Three jobs:
 *
 * 1. Be a Loader row, because a browser half is only discovered through one
 *    (see `dsh.client` in package.json).
 * 2. Serve the one thing the browser cannot compute for itself: the text of a
 *    side chat's last answer, so "carry back to the main line" can put it in
 *    the parent's composer without the user copying by hand.
 * 3. Queue that answer as model-facing context on the parent session, for users
 *    who want the conclusion available to the next turn without putting words
 *    in their own mouth.
 *
 * Why a route instead of a session event: an out-of-tree plugin cannot write a
 * durable, model-visible event into a session log. `session.append` accepts any
 * type in memory, but the persistence read path rejects a log whose types are
 * outside `KNOWN_SESSION_EVENT_TYPES` ("unknown to this harness and not marked
 * ignorable"), and only in-tree code may append ignorable plugin records — which
 * never reach the model anyway. Reading the child's log, and handing text to
 * `agent.inject` (which persists a plain `user/message`), are the supported
 * paths.
 */

/** Plugin name shown by the Loader. */
export const name = 'dsh-side-chat'

/** HTTP path the browser half calls to read a side chat's newest answer. */
const HANDOFF_PATH = '/side-chat/handoff'

/** HTTP path the browser half calls to drop a note into the main line's context. */
const CONTEXT_PATH = '/side-chat/context'

/** Upper bound on the text handed to the browser; the composer is not a buffer. */
const MAX_TEXT = 8000

/** Upper bound on a request body; anything larger is not a note from a side chat. */
const MAX_BODY = 24000

/** How far back to look for an answer before giving up. */
const MAX_EVENTS_SCANNED = 200

/**
 * Host services this plugin can use. The webserver is requested optionally
 * below, so a profile without one (headless, tui) keeps working and the browser
 * half degrades to "copy it yourself".
 */
export const inject = []

/**
 * Register the routes once a webserver is live.
 *
 * The dependency is declared through `ctx.inject` instead of a plain
 * `ctx.get('webServer')` at apply time. Plugin bodies run as soon as their own
 * dependencies are ready, which is not necessarily after the webserver's own
 * fiber became active: reading the service eagerly returned `undefined`, the
 * routes were never registered, and every carry-back in the browser hit an
 * empty 404. `ctx.inject` keeps this half inert on profiles without a
 * webserver (headless, tui) instead of failing them.
 *
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (server) => {
    const webServer = server.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    server.effect(
      () => webServer.register({ kind: 'exact', path: HANDOFF_PATH, handler: (req, res) => { void handle(server, req, res) } }),
      'dsh-side-chat: handoff route',
    )
    server.effect(
      () => webServer.register({ kind: 'exact', path: CONTEXT_PATH, handler: (req, res) => { void handleContext(server, req, res) } }),
      'dsh-side-chat: context route',
    )
  })
}

/**
 * Serve one side chat's last answer.
 * @param ctx - Host plugin context.
 * @param req - Node request.
 * @param res - Node response.
 */
async function handle(ctx, req, res) {
  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    send(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (!trusted(req)) {
    send(res, 403, { ok: false, error: 'untrusted request origin' })
    return
  }
  const params = queryOf(req)
  const child = params === undefined ? '' : params.get('child') || ''
  const parent = params === undefined ? '' : params.get('parent') || ''
  if (!isSessionId(child)) {
    send(res, 400, { ok: false, error: 'invalid child session id' })
    return
  }
  if (!isSessionId(parent)) {
    send(res, 400, { ok: false, error: 'invalid parent session id' })
    return
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || typeof persistence.open !== 'function') {
    send(res, 503, { ok: false, error: 'session persistence is not mounted' })
    return
  }

  let handle
  try {
    handle = await persistence.open(child, 'read')
  } catch (error) {
    send(res, 404, { ok: false, error: describe(error) })
    return
  }
  try {
    // Ownership, not authentication: knowing a session id is not a licence to
    // read its prose. A side chat is a fork, so its header names the parent.
    const owner = handle.header === null || typeof handle.header !== 'object' ? undefined : handle.header.parentSession
    if (owner !== parent) {
      send(res, 403, { ok: false, error: 'this side chat does not belong to that session' })
      return
    }
    const { events } = await handle.read()
    const answer = lastAnswer(events)
    send(res, 200, {
      ok: true,
      childSessionId: child,
      title: titleOf(handle.header),
      text: answer === undefined ? '' : answer.text.slice(0, MAX_TEXT),
      turn: answer === undefined ? null : answer.turn,
      truncated: answer !== undefined && answer.text.length > MAX_TEXT,
    })
  } catch (error) {
    send(res, 500, { ok: false, error: describe(error) })
  } finally {
    try {
      await handle.close()
    } catch {
      // A read handle that fails to close holds nothing worth reporting.
    }
  }
}

/**
 * Queue a side chat's conclusion as model-facing context on the main line.
 *
 * `agent.inject` is the one supported way to make text visible to the next turn
 * without saying it in the user's voice and without waking an idle session: the
 * message persists as an ordinary `user/message` whose `source.kind` marks it as
 * plugin context, and the stock chat view already renders those as a context
 * line rather than a bubble.
 *
 * @param ctx - Host plugin context.
 * @param req - Node request.
 * @param res - Node response.
 */
async function handleContext(ctx, req, res) {
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    send(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (!trusted(req)) {
    send(res, 403, { ok: false, error: 'untrusted request origin' })
    return
  }
  // A custom header cannot be set by a cross-site form or image, and a
  // cross-site fetch that sets it needs a preflight this server never grants.
  if (headerOf(req, 'x-side-chat') !== '1') {
    send(res, 403, { ok: false, error: 'missing request marker' })
    return
  }
  let body
  try {
    body = await readBody(req)
  } catch (error) {
    send(res, 400, { ok: false, error: describe(error) })
    return
  }
  const sessionId = body !== null && typeof body === 'object' ? body.sessionId : undefined
  const text = body !== null && typeof body === 'object' ? body.text : undefined
  const parent = body !== null && typeof body === 'object' ? body.parent : undefined
  if (!isSessionId(sessionId)) {
    send(res, 400, { ok: false, error: 'invalid session id' })
    return
  }
  if (parent !== undefined && !isSessionId(parent)) {
    send(res, 400, { ok: false, error: 'invalid parent session id' })
    return
  }
  if (typeof text !== 'string' || text.trim() === '') {
    send(res, 400, { ok: false, error: 'invalid text' })
    return
  }
  const agents = ctx.get('agents')
  if (agents === undefined || typeof agents.get !== 'function') {
    send(res, 503, { ok: false, error: 'the agent registry is not mounted' })
    return
  }
  const agent = agents.get(sessionId)
  if (agent === undefined || typeof agent.inject !== 'function') {
    send(res, 409, { ok: false, error: 'the session is not live; use the draft instead' })
    return
  }
  try {
    agent.inject({
      id: newMessageId(),
      role: 'user',
      content: [{ type: 'text', text: text.slice(0, MAX_TEXT) }],
      source: parent === undefined ? { kind: 'side-chat' } : { kind: 'side-chat', parent },
    })
    send(res, 200, { ok: true, sessionId })
  } catch (error) {
    send(res, 500, { ok: false, error: describe(error) })
  }
}

/**
 * Whether a request comes from this page, in the weakest sense worth enforcing.
 *
 * Not authentication — the GUI's own session is the only credential here. This
 * blocks the two things a hostile page can otherwise do to a localhost server:
 * drive it from another origin, or read its replies.
 *
 * @param req - Node request.
 * @returns {boolean} true when the request looks first-party.
 */
function trusted(req) {
  const site = headerOf(req, 'sec-fetch-site')
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const origin = headerOf(req, 'origin')
  if (origin === undefined) return true
  const host = headerOf(req, 'host')
  if (host === undefined) return false
  return origin === `http://${host}` || origin === `https://${host}`
}

/**
 * Read one request header, case-insensitively, as a lowercase string.
 * @param req - Node request.
 * @param name - lower-case header name.
 * @returns {string | undefined} the header value.
 */
function headerOf(req, name) {
  const headers = req.headers
  if (headers === undefined || headers === null) return undefined
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name]
  return typeof value === 'string' ? value.toLowerCase() : undefined
}

/**
 * Parse a request URL into search params without throwing on junk.
 * @param req - Node request.
 * @returns {URLSearchParams | undefined} params, or undefined when unparseable.
 */
function queryOf(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams
  } catch {
    return undefined
  }
}

/**
 * Whether a value can be a session id.
 * @param value - candidate.
 * @returns {boolean} true when it is a plausible id.
 */
function isSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value)
}

/**
 * Read a JSON request body, refusing anything oversized before parsing it.
 * @param req - Node request.
 * @returns {Promise<unknown>} parsed body.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') throw new Error('request body is empty')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('request body is not JSON')
  }
}

/**
 * Mint an identity for an injected message.
 *
 * The harness mints these with `randomUUID()`; matching that keeps injected
 * context indistinguishable in shape from anything the loop produces.
 *
 * @returns {string} a fresh id.
 */
function newMessageId() {
  const random = globalThis.crypto?.randomUUID
  if (typeof random === 'function') return random.call(globalThis.crypto)
  return `side-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Walk the log backwards for the newest assistant answer with visible prose.
 * Exported for the host test; not part of any public contract.
 * @param events - stored session events, in seq order.
 * @returns the answer text and its turn, when one exists.
 */
export function lastAnswer(events) {
  const from = Math.max(0, events.length - MAX_EVENTS_SCANNED)
  for (let index = events.length - 1; index >= from; index -= 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const blocks = contentOf(data)
    if (!Array.isArray(blocks)) continue
    const text = blocks
      .filter((block) => block !== null && typeof block === 'object' && isTextBlock(block) && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text === '') continue
    return { text, turn: typeof data.turn === 'number' ? data.turn : null }
  }
  return undefined
}

/**
 * Find the content blocks of an assistant message across the shapes the log uses.
 *
 * A stored `assistant/message` keeps its parts directly under `data.content`,
 * while the in-memory message nests them under `data.message.content`. Both are
 * read here: the log is the authority, and guessing one shape is what made
 * carry-back answer "no answer yet" for every real session.
 *
 * @param data - the event payload.
 * @returns the parts, when it has any.
 */
function contentOf(data) {
  if (Array.isArray(data.content)) return data.content
  const message = data.message
  if (message === null || typeof message !== 'object') return undefined
  return Array.isArray(message.content) ? message.content : undefined
}

/**
 * Whether one message part is prose.
 *
 * Persisted parts are tagged `type`; the in-memory message tags them `kind`.
 *
 * @param block - one message part.
 * @returns true when the part is text.
 */
function isTextBlock(block) {
  return block.type === 'text' || block.kind === 'text'
}

/**
 * Read a display title off a stored header without trusting its shape.
 * @param header - stored session header.
 * @returns the title, or an empty string.
 */
function titleOf(header) {
  const title = header === null || typeof header !== 'object' ? undefined : header.title
  return typeof title === 'string' ? title : ''
}

/**
 * Flatten an error into one readable line.
 * @param error - anything thrown.
 * @returns the message.
 */
function describe(error) {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/**
 * Write one JSON response.
 * @param res - Node response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function send(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}
