/**
 * Host half of dsh-side-chat.
 *
 * Two jobs:
 *
 * 1. Be a Loader row, because a browser half is only discovered through one
 *    (see `dsh.client` in package.json).
 * 2. Serve the one thing the browser cannot compute for itself: the text of a
 *    side chat's last answer, so "carry back to the main line" can put it in
 *    the parent's composer without the user copying by hand.
 *
 * Why a route instead of a session event: an out-of-tree plugin cannot write a
 * durable, model-visible event into a session log. `session.append` accepts any
 * type in memory, but the persistence read path rejects a log whose types are
 * outside `KNOWN_SESSION_EVENT_TYPES` ("unknown to this harness and not marked
 * ignorable"), and only in-tree code may append ignorable plugin records — which
 * never reach the model anyway. Reading the child's log is the supported path.
 */

/** Plugin name shown by the Loader. */
export const name = 'dsh-side-chat'

/** HTTP path the browser half calls. */
const HANDOFF_PATH = '/side-chat/handoff'

/** Upper bound on the text handed to the browser; the composer is not a buffer. */
const MAX_TEXT = 8000

/** How far back to look for an answer before giving up. */
const MAX_EVENTS_SCANNED = 200

/**
 * Host services this plugin can use. Neither is mandatory: a profile without a
 * webserver (headless, tui) simply has no route to serve, and the browser half
 * degrades to "copy it yourself".
 */
export const inject = []

/**
 * Register the handoff route when the profile has a webserver.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') return
  ctx.effect(
    () => webServer.register({ kind: 'exact', path: HANDOFF_PATH, handler: (req, res) => { void handle(ctx, req, res) } }),
    'dsh-side-chat: handoff route',
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
