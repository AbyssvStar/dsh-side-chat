# dsh-side-chat

A Codex-style side chat for the DSH web GUI: branch a conversation from any
finished turn, keep working in a panel beside it, and carry the result back.

A side chat is a real forked session, not a scratch buffer. It copies the exact
prefix of the parent up to the turn you branched from, then runs on its own
model and tools. Nothing flows between the two unless you ask for it, so a
side chat can explore a bad idea without touching the main line.

## What it does

- **Branch from any turn.** Every finished turn in the main conversation grows
  a `◫` action. It forks at that turn and opens the child in the right sidebar.
  Unlike the built-in branch, it does not leave the current conversation.
- **A full chat, not a preview.** The panel embeds the same conversation view
  as the main window, with its own composer, tools, and approvals.
- **Carry back, deliberately.** Inside a side chat, `↩` puts its last answer
  into the parent's composer as a draft. You see it, edit it, and decide when
  to send. If the composer cannot take it, the note is sent as a user message
  instead — the only other channel the model can see.
- **Carry back as background.** `Shift`-click `↩` instead queues the same text
  as model-facing context on the main line: the next turn can see it, nothing
  is woken, and the plugin never speaks in your voice. The chat view already
  renders plugin-sourced context as a context line rather than a bubble.
- **Quote, don't dump.** Select text before pressing `↩` and only the selection
  is carried back, not the whole answer.
- **The chip tells the truth.** A side chat often keeps running while you work
  elsewhere; its tab title pulses while it does.

## Install

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-side-chat
```

Then reload the web GUI. While developing, `link:` means the files under `lib/`
are read from this checkout, so a reload picks up a rebuilt bundle; the host
half (`lib/index.js`) needs a restart because it is loaded by the Node process.

## How carry-back works

DSH does not let an out-of-tree plugin append a model-visible event to a
session log: persistence refuses logs whose event types are outside its known
set, and the "ignorable" escape hatch is for in-tree plugins and never reaches
the model. So the browser half asks the host half for the child's last answer
over `GET /side-chat/handoff?child=<sessionId>`, and the host half reads the
stored log through `sessionPersistence` — read-only, one route, no new
dependencies.

The context carrier goes the other way, over `POST /side-chat/context`, because
only the host can reach a live agent: `agent.inject()` persists an ordinary
`user/message` whose `source.kind` is `side-chat`. That is a known event type, so
the log stays readable, and it reaches the model without impersonating the user.
If the parent session is cold, the host answers `409` and the browser falls back
to the draft.

## Who may call the host routes

Both routes are loopback-only in practice, but "loopback" is not a permission
check: any page the browser loads can try. Two cheap fences:

- **Origin.** A request that names a `Sec-Fetch-Site` other than `same-origin`
  or `none`, or an `Origin` that is not this host, is refused with `403`.
- **Ownership.** The handoff route takes `child` *and* `parent` and refuses with
  `403` unless the stored log's `parentSession` matches. Knowing a session id is
  not a licence to read its prose.

The write route also requires an `X-Side-Chat: 1` header. A cross-site form or
image cannot set a custom header, and a cross-site `fetch` that does needs a
preflight this server never grants.

These are not authentication — the GUI's own session is the only credential on
this socket — and they do not stop a hostile *local* process. They stop a hostile
web page.

## Known limits

- **A fork is listed in the session list.** DSH has no hidden flag for sessions,
  and every supported alternative costs more than it saves: archiving makes a
  session unable to run a turn, and the subagent origin turns the composer
  read-only. The child therefore appears under its parent, indented.
- Only the browser half needs the GUI; the host route is optional. Without a
  webserver (headless, tui) the panel still works and carry-back falls back to
  copy and paste.
- Side chats are per browser profile: the parent-child link lives in
  `localStorage` under `dsh.side-chat.v1`.

## Tests

```sh
npm test
```

Two suites run without a browser: `test/client.test.mjs` evaluates the real
bundle against a stub runtime, and `test/host.test.mjs` drives both routes and
the log scan.

## Compatibility

The plugin leans on harness seams that are not a public API: `ctx.get('agents')`,
`ctx.get('sessionPersistence')`, `ctx.get('webServer')`, and four client seats
(`conversation.chat.turnTail`, `sidebar.right.pane.tab`, its `.title`, and
`requestDraftInitialization`). A DSH upgrade may move any of them.

```sh
npm run check            # or: node scripts/check-dsh-compat.mjs <dsh-root>
```

That script asserts each seam still exists in the installed DSH and names the
one that broke, rather than leaving it to a browser console. It was written
against DSH 0.2.1-rc.2.
