/**
 * Check that the installed DSH still has the seams this plugin leans on.
 *
 * The plugin talks to private services (`ctx.get('sessionPersistence')`,
 * `ctx.get('agents')`, `ctx.get('webServer')`) and to client seats that are not
 * a public API surface. A DSH upgrade is allowed to move any of them; when it
 * does, this script says which assumption broke instead of leaving the failure
 * to a browser console.
 *
 * Usage: node scripts/check-dsh-compat.mjs [dsh-install-root]
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Candidate roots, most explicit first.
 * @returns {string[]} directories that might hold `@deepseek-ai/*`.
 */
function candidateRoots() {
  const roots = []
  if (process.argv[2] !== undefined) roots.push(process.argv[2])
  if (process.env.DSH_ROOT !== undefined) roots.push(process.env.DSH_ROOT)
  // npm's global prefix keeps packages beside the node binary that installed
  // them, except on Windows, where `npm -g` puts them under %APPDATA%\npm.
  roots.push(join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'))
  if (process.env.APPDATA !== undefined) {
    roots.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  }
  roots.push(join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh'))
  return roots
}

/**
 * Find the directory that actually holds the DSH packages.
 * @returns {string | undefined} a package root such as `.../dsh/node_modules/@deepseek-ai`.
 */
function findBundledRoot() {
  for (const root of candidateRoots()) {
    const bundled = join(root, 'node_modules', '@deepseek-ai')
    if (existsSync(bundled)) return bundled
    if (existsSync(join(root, 'dsh'))) return join(root, 'dsh')
  }
  return undefined
}

/** Every assumption this plugin makes about the harness, as a file plus a marker. */
const ASSUMPTIONS = [
  ['a turn tail can host a button', 'dsh-client-ui-chat/lib/client.js', 'conversation.chat.turnTail'],
  ['a tab title is a seat', 'dsh-client-ui-sidebar-right/lib/client.js', 'sidebar.right.pane.tab.title'],
  ['a tab body is a seat', 'dsh-client-ui-sidebar-right/lib/client.js', 'sidebar.right.pane.tab'],
  ['the composer takes a programmatic draft', 'dsh-client-ui-conversation/lib/client.js', 'requestDraftInitialization'],
  ['an agent can be handed context', 'dsh-agent/lib/types/runtime-types.d.ts', 'inject('],
  ['a stored log can be opened read-only', 'dsh-session-persistence/lib/types/index.d.ts', 'open('],
  ['assistant prose is a known event', 'dsh-session/lib/types/known-event-types.js', 'assistant/message'],
]

const root = findBundledRoot()
if (root === undefined) {
  console.error('check-dsh-compat: could not find an installed DSH; pass its root as the first argument')
  process.exit(2)
}

let failures = 0
for (const [label, relative, marker] of ASSUMPTIONS) {
  const file = join(root, relative)
  let state
  if (!existsSync(file)) state = `missing ${relative}`
  else if (!readFileSync(file, 'utf8').includes(marker)) state = `${relative} no longer mentions ${marker}`
  else state = 'ok'
  if (state !== 'ok') failures += 1
  console.log(`${state === 'ok' ? 'ok  ' : 'FAIL'}  ${label}${state === 'ok' ? '' : ` — ${state}`}`)
}

console.log(failures === 0 ? '\nthe installed DSH still offers every seam this plugin uses' : `\n${failures} assumption(s) broke`)
process.exit(failures === 0 ? 0 : 1)
