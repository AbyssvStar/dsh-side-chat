/**
 * Contract tests for the host half: the handoff route and the log scan behind it.
 *
 * The route is the only thing a browser cannot do for itself, so it is worth
 * pinning: which verb, which path, which failures, and what a stored log has to
 * look like before we hand its prose to the composer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, lastAnswer, name } from '../lib/index.js'

/**
 * Build a host context whose webserver records what got registered.
 * @returns {{ ctx: object, routes: object[] }} fake context plus registered routes.
 */
function withWebServer() {
  const routes = []
  const ctx = {
    get(serviceName) {
      if (serviceName === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(factory) {
      return factory()
    },
  }
  return { ctx, routes }
}

/**
 * A response object that remembers what the handler wrote.
 * @returns {object} writable response double.
 */
function createResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
  return response
}

/**
 * Drive the registered route once.
 * @param {{ routes: object[], ctx: object }} harness - context with its routes.
 * @param {{ method?: string, url: string }} request - what the browser sends.
 * @returns {Promise<{ status: number, json: any, headers: object }>} the reply.
 */
async function call(harness, request) {
  apply(harness.ctx)
  const [route] = harness.routes
  assert.ok(route, 'the handoff route should be registered')
  const response = createResponse()
  await route.handler({ method: request.method ?? 'GET', url: request.url }, response)
  // The route hands off to an async handler without returning it; let it settle.
  for (let ticks = 0; ticks < 50 && response.body === ''; ticks += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { status: response.statusCode, json: JSON.parse(response.body), headers: response.headers }
}

/**
 * A stored session log with one assistant answer.
 * @param {string} text - answer prose.
 * @param {number} turn - turn index.
 * @returns {object[]} log events.
 */
function logWith(text, turn) {
  return [
    { seq: 0, type: 'turn/start', data: { turn } },
    {
      seq: 1,
      type: 'assistant/message',
      data: { turn, step: 0, message: { content: [{ kind: 'text', text }] } },
    },
    { seq: 2, type: 'turn/end', data: { turn } },
  ]
}

test('registers an exact GET route only when a webserver exists', () => {
  const bare = withWebServer()
  apply({ get: () => undefined, effect: (factory) => factory() })
  assert.equal(bare.routes.length, 0)

  apply(bare.ctx)
  assert.equal(bare.routes.length, 1)
  assert.equal(bare.routes[0].kind, 'exact')
  assert.equal(bare.routes[0].path, '/side-chat/handoff')
  assert.equal(typeof bare.routes[0].handler, 'function')
})

test('rejects a non-GET request without touching persistence', async () => {
  const { ctx, routes } = withWebServer()
  const reply = await call({ ctx, routes }, { method: 'POST', url: '/side-chat/handoff?child=abc' })
  assert.equal(reply.status, 405)
  assert.equal(reply.json.ok, false)
})

test('rejects a missing or malformed child id', async () => {
  const { ctx, routes } = withWebServer()
  const missing = await call({ ctx, routes }, { url: '/side-chat/handoff' })
  assert.equal(missing.status, 400)

  const hostile = await call({ ctx, routes }, { url: '/side-chat/handoff?child=../../etc/passwd' })
  assert.equal(hostile.status, 400)
})

test('reports an unmounted persistence service instead of pretending to be empty', async () => {
  const { ctx, routes } = withWebServer()
  const reply = await call({ ctx, routes }, { url: '/side-chat/handoff?child=session-child-1' })
  assert.equal(reply.status, 503)
  assert.match(reply.json.error, /persistence/)
})

test('answers with the last prose of an existing side chat', async () => {
  const events = logWith('  use a Map, not an array  ', 2)
  const closed = []
  const { ctx, routes } = withWebServer()
  ctx.get = (serviceName) =>
    serviceName === 'webServer'
      ? { register: (route) => (routes.push(route), () => {}) }
      : {
          async open(id, mode) {
            assert.equal(id, 'session-child-1')
            assert.equal(mode, 'read')
            return {
              header: { title: 'Side chat · main · fork 3' },
              async read() {
                return { events }
              },
              async close() {
                closed.push(id)
              },
            }
          },
        }

  const reply = await call({ ctx, routes }, { url: '/side-chat/handoff?child=session-child-1' })

  assert.equal(reply.status, 200)
  assert.deepEqual(reply.json, {
    ok: true,
    childSessionId: 'session-child-1',
    title: 'Side chat · main · fork 3',
    text: 'use a Map, not an array',
    turn: 2,
    truncated: false,
  })
  assert.equal(reply.headers['cache-control'], 'no-store')
  assert.deepEqual(closed, ['session-child-1'], 'the read handle must be closed')
})

test('truncates a very long answer and says so', async () => {
  const events = logWith('x'.repeat(9000), 1)
  const { ctx, routes } = withWebServer()
  ctx.get = (serviceName) =>
    serviceName === 'webServer'
      ? { register: (route) => (routes.push(route), () => {}) }
      : {
          async open() {
            return { header: {}, read: async () => ({ events }), close: async () => {} }
          },
        }

  const reply = await call({ ctx, routes }, { url: '/side-chat/handoff?child=session-child-1' })
  assert.equal(reply.status, 200)
  assert.equal(reply.json.text.length, 8000)
  assert.equal(reply.json.truncated, true)
  assert.equal(reply.json.turn, 1)
})

test('maps an unreadable side chat to 404', async () => {
  const { ctx, routes } = withWebServer()
  ctx.get = (serviceName) =>
    serviceName === 'webServer'
      ? { register: (route) => (routes.push(route), () => {}) }
      : {
          async open() {
            throw new Error('no such session')
          },
        }

  const reply = await call({ ctx, routes }, { url: '/side-chat/handoff?child=session-gone' })
  assert.equal(reply.status, 404)
  assert.match(reply.json.error, /no such session/)
})

test('lastAnswer prefers the newest prose and skips tool-only messages', () => {
  const events = [
    ...logWith('older answer', 0),
    {
      seq: 3,
      type: 'assistant/message',
      data: { turn: 1, step: 0, message: { content: [{ kind: 'tool-call', name: 'bash' }] } },
    },
    {
      seq: 4,
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ kind: 'text', text: '' }] } },
    },
    {
      seq: 5,
      type: 'assistant/message',
      data: { turn: 1, step: 2, message: { content: [{ kind: 'text', text: 'first para' }, { kind: 'text', text: 'second para' }] } },
    },
  ]
  assert.deepEqual(lastAnswer(events), { text: 'first para\nsecond para', turn: 1 })
})

test('lastAnswer tolerates junk and finds nothing in an empty log', () => {
  assert.equal(lastAnswer([]), undefined)
  assert.equal(lastAnswer([null, {}, { type: 'assistant/message', data: null }, { type: 'assistant/message', data: { message: { content: 'nope' } } }]), undefined)
})

test('the plugin announces a name', () => {
  assert.equal(typeof name, 'string')
  assert.equal(name, 'dsh-side-chat')
})
