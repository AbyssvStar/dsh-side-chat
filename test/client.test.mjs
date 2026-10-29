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

/**
 * Load the bundle and return its plugin exports.
 * @returns {Promise<{apply: Function, inject: string[], loads: object[], ctx: object}>}
 */
async function loadPlugin() {
  const source = await readFile(CLIENT, 'utf8')
  const loads = []
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
  return { ...plugin, loads, ctx: state }
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
  }
  const state = {
    calls,
    resources: undefined,
    tab: undefined,
    slots: [],
    dictionaries: undefined,
    styleMounted: false,
  }
  let nextId = 0
  const ctx = {
    effect(fn, _label) {
      return fn()
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
    },
  }
  state.ctx = ctx
  return state
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
    'sidechat.conversation',
  ])

  const pane = state.slots.find((slot) => slot.definition.name === 'sidebar.right.pane.tab')
  assert.equal(pane.definition.key, 'dsh-side-chat')
  assert.deepEqual(pane.definition.children, {
    'sidechat.conversation': { kind: 'single', scope: 'session' },
  })
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
  assert.equal(typeof injected.openSideChat, 'function')

  const childId = await injected.openSideChat(42)

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
