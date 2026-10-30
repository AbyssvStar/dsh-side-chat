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
 * Host services this plugin can use. Neither is mandatory: a profile without a
 * webserver (headless, tui) simply has no route to serve, and the browser half
 * degrades to "copy it yourself".
 */
export const inject = []

/**
 * Register the routes when the profile has a webserver.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') return
  ctx.effect(
    () => webServer.register({ kind: 'exact', path: HANDOFF_PATH, handler: (req, res) => { void handle(ctx, req, res) } }),
    'dsh-side-chat: handoff route',
  )
  ctx.effect(
    () => webServer.register({ kind: 'exact', path: CONTEXT_PATH, handler: (req, res) => { void handleContext(ctx, req, res) } }),
    'dsh-side-chat: context route',
  )
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
  let child = ''
  try {
    child = new URL(req.url || '/', 'http://localhost').searchParams.get('child') || ''
  } catch {
    child = ''
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(child)) {
    send(res, 400, { ok: false, error: 'invalid child session id' })
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
  let body
  try {
    body = await readBody(req)
  } catch (error) {
    send(res, 400, { ok: false, error: describe(error) })
    return
  }
  const sessionId = body !== null && typeof body === 'object' ? body.sessionId : undefined
  const text = body !== null && typeof body === 'object' ? body.text : undefined
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) {
    send(res, 400, { ok: false, error: 'invalid session id' })
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
      source: { kind: 'side-chat' },
    })
    send(res, 200, { ok: true, sessionId })
  } catch (error) {
    send(res, 500, { ok: false, error: describe(error) })
  }
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
    const blocks = data.message === null || typeof data.message !== 'object' ? undefined : data.message.content
    if (!Array.isArray(blocks)) continue
    const text = blocks
      .filter((block) => block !== null && typeof block === 'object' && block.kind === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text === '') continue
    return { text, turn: typeof data.turn === 'number' ? data.turn : null }
  }
  return undefined
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
