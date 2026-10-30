/**
 * Contract tests for both host routes — reading a side chat's answer, and
 * queueing a note on the main line's context — plus the log scan behind them.
 *
 * These routes are the only things a browser cannot do for itself, so they are
 * worth pinning: which verb, which path, which failures, and what a stored log
 * has to look like before we hand its prose to the composer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
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
 * Drive one registered route once.
 * @param {{ routes: object[], ctx: object }} harness - context with its routes.
 * @param {{ method?: string, url: string, body?: string, path?: string }} request - what the browser sends.
 * @returns {Promise<{ status: number, json: any, headers: object }>} the reply.
 */
async function call(harness, request) {
  apply(harness.ctx)
  const path = request.path ?? '/side-chat/handoff'
  const route = harness.routes.find((candidate) => candidate.path === path)
  assert.ok(route, `the ${path} route should be registered`)
  const response = createResponse()
  const base = { method: request.method ?? 'GET', url: request.url }
  const req = request.body === undefined
    ? base
    : Object.assign(Readable.from([Buffer.from(request.body, 'utf8')]), base)
  await route.handler(req, response)
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

test('registers both exact routes, and only when a webserver exists', () => {
  const bare = withWebServer()
  apply({ get: () => undefined, effect: (factory) => factory() })
  assert.equal(bare.routes.length, 0)

  apply(bare.ctx)
  assert.deepEqual(
    bare.routes.map((route) => [route.kind, route.path, typeof route.handler]),
    [
      ['exact', '/side-chat/handoff', 'function'],
      ['exact', '/side-chat/context', 'function'],
    ],
  )
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

/**
 * Build a host context that also has an agent registry.
 * @param {(sessionId: string) => object | undefined} lookup - what `agents.get` answers.
 * @returns {{ ctx: object, routes: object[], injected: object[] }} harness.
 */
function withAgents(lookup) {
  const harness = withWebServer()
  const injected = []
  const registry = {
    get(sessionId) {
      const agent = lookup(sessionId)
      if (agent === undefined) return undefined
      return {
        inject(message) {
          injected.push(message)
          if (typeof agent.onInject === 'function') agent.onInject(message)
        },
      }
    },
  }
  const inner = harness.ctx.get
  harness.ctx.get = (serviceName) => (serviceName === 'agents' ? registry : inner(serviceName))
  return { ...harness, injected }
}

test('the context route rejects a non-POST request', async () => {
  const harness = withAgents(() => ({}))
  const reply = await call(harness, { method: 'GET', url: '/side-chat/context', path: '/side-chat/context' })
  assert.equal(reply.status, 405)
  assert.equal(reply.json.ok, false)
})

test('the context route rejects a malformed body, session, or text', async () => {
  const harness = withAgents(() => ({}))
  const send = (body) => call(harness, { method: 'POST', url: '/side-chat/context', path: '/side-chat/context', body })

  assert.equal((await send('not json')).status, 400)
  assert.equal((await send(JSON.stringify({ sessionId: '../etc/passwd', text: 'hi' }))).status, 400)
  assert.equal((await send(JSON.stringify({ sessionId: 'session-main' }))).status, 400)
  assert.equal((await send(JSON.stringify({ sessionId: 'session-main', text: '   ' }))).status, 400)
  assert.equal(harness.injected.length, 0)
})

test('the context route refuses an oversized body before parsing it', async () => {
  const harness = withAgents(() => ({}))
  const huge = JSON.stringify({ sessionId: 'session-main', text: 'x'.repeat(60000) })
  const reply = await call(harness, { method: 'POST', url: '/side-chat/context', path: '/side-chat/context', body: huge })
  assert.equal(reply.status, 400)
  assert.match(reply.json.error, /too large/)
})

test('the context route degrades when the agent registry or the agent is missing', async () => {
  const registryGone = withWebServer()
  const noRegistry = await call(registryGone, {
    method: 'POST',
    url: '/side-chat/context',
    path: '/side-chat/context',
    body: JSON.stringify({ sessionId: 'session-main', text: 'note' }),
  })
  assert.equal(noRegistry.status, 503)
  assert.match(noRegistry.json.error, /agent registry/)

  const cold = withAgents(() => undefined)
  const notLive = await call(cold, {
    method: 'POST',
    url: '/side-chat/context',
    path: '/side-chat/context',
    body: JSON.stringify({ sessionId: 'session-main', text: 'note' }),
  })
  assert.equal(notLive.status, 409)
  assert.match(notLive.json.error, /not live/)
})

test('the context route queues the note as plugin-sourced user context', async () => {
  const harness = withAgents((sessionId) => (sessionId === 'session-main' ? {} : undefined))
  const reply = await call(harness, {
    method: 'POST',
    url: '/side-chat/context',
    path: '/side-chat/context',
    body: JSON.stringify({ sessionId: 'session-main', text: 'use a Map, not an array' }),
  })

  assert.equal(reply.status, 200)
  assert.deepEqual(reply.json, { ok: true, sessionId: 'session-main' })
  assert.equal(harness.injected.length, 1)
  const [message] = harness.injected
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'side-chat' })
  assert.deepEqual(message.content, [{ type: 'text', text: 'use a Map, not an array' }])
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
})

test('the context route reports a failing inject as a server error', async () => {
  const harness = withAgents(() => ({
    onInject() {
      throw new Error('agent is disposing')
    },
  }))
  const reply = await call(harness, {
    method: 'POST',
    url: '/side-chat/context',
    path: '/side-chat/context',
    body: JSON.stringify({ sessionId: 'session-main', text: 'note' }),
  })
  assert.equal(reply.status, 500)
  assert.match(reply.json.error, /disposing/)
})

test('the plugin announces a name', () => {
  assert.equal(typeof name, 'string')
  assert.equal(name, 'dsh-side-chat')
})
