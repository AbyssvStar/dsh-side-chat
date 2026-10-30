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
bundle against a stub runtime, and `test/host.test.mjs` drives the handoff route
and the log scan.
