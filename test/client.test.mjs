/**
 * Contract tests for the browser half.
 *
 * There is no browser in this environment, so the bundle is executed against a
 * hand-written stand-in for the client runtime: the real `lib/client.js` runs,
 * registers into recording services, and the assertions check exactly what it
 * hands to the Host and to the shell. This catches API-shaped mistakes (wrong
 * service, wrong argument names, unparsable addresses) without a DOM.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** Cache-buster: every load must re-execute the bundle in a fresh module. */
let run = 0

/** What the host handoff route answers on the next call. */
let handoff = { status: 200, body: { ok: true, text: 'the answer', turn: 0 } }

/** What the host context route answers on the next call. */
let context = { status: 200, body: { ok: true, sessionId: 'session-parent' } }

/** Every handoff URL the bundle asked for. */
let handoffs = []

/** Every request the bundle made, with its init. */
let requests = []

/** localStorage entries the next load should find already written. */
let seedStorage = undefined

/**
 * Reset the browser-ish globals a fresh load installs.
 * @returns {{storage: Map<string, string>}} the shared localStorage backing map.
 */
function installBrowserStubs() {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  }
  handoffs = []
  requests = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    requests.push({ url: target, init })
    if (target.startsWith('/side-chat/handoff')) handoffs.push(target)
    const reply = target.startsWith('/side-chat/context') ? context : handoff
    return {
      ok: reply.status < 400,
      status: reply.status,
      async text() {
        return reply.body === undefined ? '' : JSON.stringify(reply.body)
      },
    }
  }
  return { storage }
}

/**
 * Load the bundle and return its plugin exports.
 * @returns {Promise<{apply: Function, inject: string[], loads: object[], ctx: object}>}
 */
async function loadPlugin() {
  const source = await readFile(CLIENT, 'utf8')
  const loads = []
  const { storage } = installBrowserStubs()
  if (seedStorage !== undefined) {
    for (const [key, value] of Object.entries(seedStorage)) storage.set(key, value)
    seedStorage = undefined
  }
  globalThis.window = { __ModuleLoader__: { load: (definition) => loads.push(definition) } }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => {
      const tag = { dataset: {}, textContent: '', remove() {} }
      return tag
    },
    head: { append() {} },
  }
  run += 1
  await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}#${run}`)

  assert.equal(loads.length, 1, 'bundle must register exactly one module')
  const [definition] = loads
  const react = {
    useState: (value) => [value, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, read) => read(),
    createElement: () => null,
  }
  const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  const registry = {
    react,
    'react/jsx-runtime': jsxRuntime,
  }
  const plugin = definition.factory((name) => {
    assert.ok(name in registry, `bundle required unknown module "${name}"`)
    return registry[name]
  })

  const state = createContext()
  plugin.apply(state.ctx)
  return { ...plugin, loads, ctx: state, storage }
}

/**
 * Recording stand-in for the client root context.
 * @returns {object} fake ctx.
 */
function createContext() {
  const calls = {
    fork: [],
    openResource: [],
    retain: [],
    release: [],
    binding: [],
    draft: [],
    prompt: [],
  }
  const state = {
    calls,
    resources: undefined,
    tab: undefined,
    slots: [],
    dictionaries: undefined,
    styleMounted: false,
    services: {},
    bindings: {},
    summaries: {},
    draftResult: 'applied',
    promptResult: { ok: true, value: { accepted: true } },
  }
  let nextId = 0
  const ctx = {
    effect(fn, _label) {
      return fn()
    },
    get(name) {
      return state.services[name]
    },
    locale: {
      register(namespace, dictionaries) {
        state.dictionaries = { namespace, dictionaries }
        return () => {}
      },
      bind() {
        return (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)
      },
    },
    resources: {
      register(provider) {
        state.resources = provider
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        state.tab = definition
        return () => {}
      },
    },
    sidebarRight: {
      openResource(address, options) {
        calls.openResource.push({ address, options })
      },
    },
    slots: {
      inject(name, factory) {
        return factory()
      },
      register(definition, component) {
        state.slots.push({ definition, component })
        return () => {}
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({ byId: state.summaries }),
        subscribe: () => () => {},
      },
      async fork(options) {
        calls.fork.push(options)
        nextId += 1
        return `session-child-${nextId}`
      },
      retain(target, options) {
        calls.retain.push({ target, options })
        return {
          sessionId: target,
          release() {
            calls.release.push(target)
          },
        }
      },
      binding(id) {
        calls.binding.push(id)
        return state.bindings[id]
      },
      async using(target, options, operation) {
        return operation({
          sessionId: target,
          options,
          binding: {
            session: {
              async prompt(content, mode) {
                calls.prompt.push({ target, content, mode })
                return state.promptResult
              },
            },
          },
        })
      },
    },
  }
  state.ctx = ctx
  return state
}

/**
 * Install a stand-in `conversation` service whose draft accepts (or refuses) text.
 * @param {object} state - fake context state.
 * @returns {object} the recording draft sink.
 */
function installConversation(state) {
  const sink = { drafts: [], notices: [] }
  state.services.conversation = {
    input: {
      for() {
        return {
          notify(level, text) {
            sink.notices.push({ level, text })
          },
        }
      },
      requestDraftInitialization(binding, options) {
        sink.drafts.push({ binding, options })
        return state.draftResult
      },
    },
  }
  return sink
}

/**
 * The turn-footer registration the plugin made.
 * @param {object} state - fake context state.
 * @returns {object} slot registration.
 */
function turnTail(state) {
  const entry = state.slots.find(
    (slot) => slot.definition.name === 'conversation.chat.turnTail',
  )
  assert.ok(entry, 'expected a conversation.chat.turnTail registration')
  return entry.definition
}

test('registers one resource protocol, one tab kind, and one turn-footer entry', async () => {
  const { apply: _apply, inject, ctx } = await loadPlugin()
  const state = ctx

  assert.equal(state.resources.protocol, 'sidechat')
  assert.equal(state.tab.kind, 'sidechat')
  assert.deepEqual(state.tab.patterns, ['dsh-resource://sidechat/session/**'])
  assert.equal(state.dictionaries.namespace, 'sideChat')
  assert.ok(inject.includes('sidebarRight'))
  assert.ok(inject.includes('sessions'))

  const definitions = state.slots.map((slot) => slot.definition.name)
  assert.deepEqual(definitions.sort(), [
    'conversation.chat.turnTail',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'sidechat.conversation',
  ])

  const pane = state.slots.find((slot) => slot.definition.name === 'sidebar.right.pane.tab')
  assert.equal(pane.definition.key, 'dsh-side-chat')
  assert.deepEqual(pane.definition.children, {
    'sidechat.conversation': { kind: 'single', scope: 'session' },
  })

  const title = state.slots.find((slot) => slot.definition.name === 'sidebar.right.pane.tab.title')
  assert.equal(title.definition.key, 'dsh-side-chat', 'the chip dispatches by the same key')
  assert.equal(title.definition.inject().sessions, state.ctx.sessions)
})

test('accepts only its own addresses', async () => {
  const { ctx } = await loadPlugin()
  const { canOpen } = ctx.tab
  assert.equal(canOpen('dsh-resource://sidechat/session/session-a?parent=session-p&at=12'), true)
  assert.equal(canOpen('dsh-resource://sidechat/session/session-a?parent=session-p'), false)
  assert.equal(canOpen('dsh-resource://subagentchat/session/session-a?parent=session-p&mode=x'), false)
  assert.equal(canOpen('dsh-resource://sidechat/turn/session-a?parent=session-p&at=1'), false)
  assert.equal(canOpen('https://example.com/sidechat/session/a?parent=p&at=1'), false)
  assert.equal(canOpen('not a url'), false)
})

test('forking a turn opens a sidebar resource and never a workspace session', async () => {
  const { ctx } = await loadPlugin()
  const definition = turnTail(ctx)

  const injected = definition.inject('session-parent')
  assert.equal(injected.mode, 'open')
  assert.equal(typeof injected.run, 'function')

  const childId = await injected.run(42)

  assert.deepEqual(ctx.calls.fork, [
    { sessionId: 'session-parent', atSeq: 42, increaseTitle: false },
  ])
  assert.equal(ctx.calls.openResource.length, 1)
  const [{ address }] = ctx.calls.openResource
  assert.equal(
    address,
    `dsh-resource://sidechat/session/${encodeURIComponent(childId)}?parent=session-parent&at=42`,
  )
  assert.equal(childId, 'session-child-1')
})

test('carry-back quotes only the highlighted passage when there is one', async () => {
  const { ctx } = await loadPlugin()
  const sink = installConversation(ctx)
  ctx.bindings['session-parent'] = { sessionId: 'session-parent' }

  const childId = await turnTail(ctx).inject('session-parent').run(5)
  handoff = { status: 200, body: { ok: true, text: 'a long answer\nwith several lines', turn: 0 } }
  globalThis.getSelection = () => ({ toString: () => '  with several lines  ' })

  try {
    const result = await turnTail(ctx).inject(childId).run(0)
    assert.equal(result, 'drafted')
    assert.equal(
      sink.drafts[0].options.prompt,
      '侧聊里引用的内容：\n\nwith several lines',
    )
    assert.doesNotMatch(sink.drafts[0].options.prompt, /a long answer/)
  } finally {
    delete globalThis.getSelection
  }
})

test('carry-back falls back to the whole answer without a selection', async () => {
  const { ctx } = await loadPlugin()
  const sink = installConversation(ctx)
  ctx.bindings['session-parent'] = { sessionId: 'session-parent' }

  const childId = await turnTail(ctx).inject('session-parent').run(5)
  handoff = { status: 200, body: { ok: true, text: 'the whole answer', turn: 0 } }
  globalThis.getSelection = () => ({ toString: () => '   ' })

  try {
    await turnTail(ctx).inject(childId).run(0)
    assert.equal(sink.drafts[0].options.prompt, '侧聊的结论：\n\nthe whole answer')
  } finally {
    delete globalThis.getSelection
  }
})

test('a side chat offers carry-back from its own turns, across a reload', async () => {
  const first = await loadPlugin()
  const childId = await turnTail(first.ctx).inject('session-parent').run(7)
  assert.equal(turnTail(first.ctx).inject(childId).mode, 'carry')

  // A page reload rebuilds the plugin from storage alone.
  seedStorage = { 'dsh.side-chat.v1': first.storage.get('dsh.side-chat.v1') }
  const reloaded = await loadPlugin()
  const injected = turnTail(reloaded.ctx).inject(childId)
  assert.equal(injected.mode, 'carry')
  assert.equal(turnTail(reloaded.ctx).inject('session-unrelated').mode, 'open')
})

test('carry-back puts the answer in the main composer instead of speaking for the user', async () => {
  const { ctx } = await loadPlugin()
  const sink = installConversation(ctx)
  ctx.bindings['session-parent'] = { sessionId: 'session-parent' }

  const childId = await turnTail(ctx).inject('session-parent').run(3)
  handoff = { status: 200, body: { ok: true, text: '  use a Map, not an array  ', turn: 2 } }

  const result = await turnTail(ctx).inject(childId).run(0)

  assert.equal(result, 'drafted')
  assert.deepEqual(handoffs, [
    `/side-chat/handoff?child=${encodeURIComponent(childId)}&parent=session-parent`,
  ])
  assert.equal(sink.drafts.length, 1)
  assert.equal(sink.drafts[0].binding, ctx.bindings['session-parent'])
  assert.equal(sink.drafts[0].options.clearPreviousDraft, false)
  assert.match(sink.drafts[0].options.prompt, /^侧聊的结论：/)
  assert.match(sink.drafts[0].options.prompt, /use a Map, not an array/)
  assert.deepEqual(ctx.calls.prompt, [])
})

test('carry-back sends a message when the composer cannot take the draft', async () => {
  const { ctx } = await loadPlugin()
  const sink = installConversation(ctx)
  ctx.draftResult = 'preserved'
  ctx.bindings['session-parent'] = { sessionId: 'session-parent' }

  const childId = await turnTail(ctx).inject('session-parent').run(3)
  handoff = { status: 200, body: { ok: true, text: 'conclusion', turn: 0 } }

  const result = await turnTail(ctx).inject(childId).run(0)

  assert.equal(result, 'sent')
  assert.equal(sink.drafts.length, 1, 'the draft is still offered first')
  assert.equal(ctx.calls.prompt.length, 1)
  assert.equal(ctx.calls.prompt[0].target, 'session-parent')
  assert.equal(ctx.calls.prompt[0].mode, 'queue')
  assert.deepEqual(ctx.calls.prompt[0].content, [
    { type: 'text', text: '侧聊的结论：\n\nconclusion' },
  ])
})

test('carry-back reports an empty side chat instead of drafting nothing', async () => {
  const { ctx } = await loadPlugin()
  const sink = installConversation(ctx)
  ctx.bindings['session-parent'] = { sessionId: 'session-parent' }

  const childId = await turnTail(ctx).inject('session-parent').run(3)
  handoff = { status: 200, body: { ok: true, text: '   ', turn: null } }

  await assert.rejects(turnTail(ctx).inject(childId).run(0), /no answer yet/)
  assert.equal(sink.drafts.length, 0)
  assert.deepEqual(ctx.calls.prompt, [])
})

test('an unreachable host route is reported as a status, not as a JSON error', async () => {
  const { ctx } = await loadPlugin()
  installConversation(ctx)
  ctx.bindings['session-parent'] = { sessionId: 'session-parent' }

  const childId = await turnTail(ctx).inject('session-parent').run(3)
  // A plugin whose host half never registered the route answers an empty 404.
  handoff = { status: 404, body: undefined }

  await assert.rejects(turnTail(ctx).inject(childId).run(0), /carry-back: HTTP 404 with an empty body/)
})

test('shift carry-back queues the conclusion as main-line context', async () => {
  const { ctx } = await loadPlugin()
  const sink = installConversation(ctx)
  ctx.bindings['session-parent'] = { sessionId: 'session-parent' }

  const childId = await turnTail(ctx).inject('session-parent').run(3)
  handoff = { status: 200, body: { ok: true, text: 'use a Map, not an array', turn: 2 } }
  context = { status: 200, body: { ok: true, sessionId: 'session-parent' } }

  const result = await turnTail(ctx).inject(childId).run(0, { inject: true })

  assert.equal(result, 'injected')
  const post = requests.find((request) => request.url === '/side-chat/context')
  assert.ok(post, 'the context route should be called')
  assert.equal(post.init.method, 'POST')
  assert.equal(post.init.credentials, 'same-origin')
  assert.equal(post.init.headers['Content-Type'], 'application/json')
  // The marker is what a cross-site caller cannot set without a preflight the host never grants.
  assert.equal(post.init.headers['X-Side-Chat'], '1')
  assert.deepEqual(JSON.parse(post.init.body), {
    sessionId: 'session-parent',
    text: '侧聊的结论：\n\nuse a Map, not an array',
    parent: childId,
  })
  assert.equal(sink.drafts.length, 0, 'context needs no composer')
  assert.deepEqual(ctx.calls.prompt, [])
})

test('a cold main line falls back from context to the composer draft', async () => {
  const { ctx } = await loadPlugin()
  const sink = installConversation(ctx)
  ctx.bindings['session-parent'] = { sessionId: 'session-parent' }

  const childId = await turnTail(ctx).inject('session-parent').run(3)
  handoff = { status: 200, body: { ok: true, text: 'conclusion', turn: 0 } }
  context = { status: 409, body: { ok: false, error: 'the session is not live; use the draft instead' } }

  const result = await turnTail(ctx).inject(childId).run(0, { inject: true })

  assert.equal(result, 'drafted')
  assert.equal(sink.drafts.length, 1)
  assert.match(sink.drafts[0].options.prompt, /conclusion/)
})

test('the resource provider retains the child for the tab lifetime and releases it', async () => {
  const { ctx } = await loadPlugin()
  const controller = new AbortController()
  const iterator = ctx.resources.open(
    'dsh-resource://sidechat/session/session-child-9?parent=session-parent&at=3',
    { signal: controller.signal },
  )

  const first = await iterator.next()
  assert.equal(first.done, false)
  assert.equal(first.value.ok, true)
  assert.equal(first.value.value.childSessionId, 'session-child-9')
  assert.equal(first.value.value.parentSessionId, 'session-parent')
  assert.equal(first.value.value.atSeq, 3)
  assert.deepEqual(ctx.calls.retain, [
    {
      target: 'session-child-9',
      options: { source: 'sidebarChat', signal: controller.signal },
    },
  ])
  assert.equal(first.value.value.reference.sessionId, 'session-child-9')

  controller.abort()
  const last = await iterator.next()
  assert.equal(last.done, true)
  assert.deepEqual(ctx.calls.release, ['session-child-9'])
})

test('an invalid address is rejected before anything is retained', async () => {
  const { ctx } = await loadPlugin()
  const iterator = ctx.resources.open('dsh-resource://sidechat/session/x', {
    signal: new AbortController().signal,
  })
  await assert.rejects(iterator.next(), /invalid side-chat address/)
  assert.deepEqual(ctx.calls.retain, [])
})
