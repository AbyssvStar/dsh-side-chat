# dsh-side-chat

[中文](README.zh-CN.md) | **English**

A Codex-style side chat for the DSH web GUI: branch the main conversation at any finished turn, keep working in the right sidebar, and carry the conclusion back when you are done — without interrupting the main line.

A side chat is a real forked session, not a reference or a preview. It copies the exact event prefix of the parent up to the branch point and then runs on its own model and tools. Nothing flows between the two by default, so a side chat can explore a direction you are unsure about without touching the main line.

## Contents

- [Features](#features) · [Install](#install) · [Usage](#usage) · [How it works](#how-it-works)
- [Access control](#access-control) · [Known limits](#known-limits) · [Compatibility](#compatibility)
- [Development and tests](#development-and-tests) · [Documents](#documents)

## Features

### Branching and the session

- **Branch from any turn.** Every finished answer in the main line carries a `◫` action that forks at that turn and opens the child in the right sidebar. Unlike the built-in branch, it does not navigate the main window away.
- **A full chat panel.** The panel embeds the same conversation view as the main window, with its own composer, tool calls, and approvals.
- **Visible activity.** While a side chat keeps running in the background, its tab title pulses, so you do not have to switch to it to find out.

### Carrying back

- **Summarise, then carry.** Pressing `↩` inside a side chat first asks that side chat to condense the conversation into a short conclusion — a real turn, visible in its transcript — and then puts the conclusion into the parent's composer. Whether it is sent is up to you.
- **Carry only the selection.** Select text before pressing `↩` and the selection is carried instead of a summary.
- **Never speaks for you.** A carry writes a draft. If the composer cannot take it (the session moved away, the page just reloaded), the carry reports a failure instead of degrading into a message you never wrote.

### Entries

- **From the split.** The empty right column lists every tab type as an entry capsule. Side chat contributes two:
  - **Side chat · follow the main line** forks the latest finished turn;
  - **Side chat · blank** starts a session that carries no context, for questions unrelated to the current task. A blank side chat has no origin, so it offers no carry-back action.
- **Quoting the other way.** Selecting text anywhere on the page — a main-line answer, a tool result — reveals a `↬` button that writes the passage into the open side chat's composer, or opens a new side chat first when none is open.

### Lifecycle

- **Automatic naming.** A fork inherits its parent's title verbatim, so a new side chat is renamed to `Side chat · MM-DD HH:mm` shortly after it opens, which keeps the session list readable.
- **Archive on close, if you want.** Closing the tab raises a card at the top of the page asking whether to archive the child. Archiving removes it from the list (it stays recoverable under the archive filter); keeping it leaves everything as it is.

## Install

`dsh plugin` forwards its arguments to pnpm verbatim, so any source pnpm accepts will work: a GitHub repository, a Git URL, a tarball, or a local directory. The repository ships the built `lib/`, so installing from source needs no build step.

### From GitHub

```sh
dsh plugin --profile web add github:AbyssvStar/dsh-side-chat
```

That fetches the tip of `main`. Pin a tag or commit with a suffix:

```sh
dsh plugin --profile web add github:AbyssvStar/dsh-side-chat#<tag-or-commit>
```

### From npm

```sh
dsh plugin --profile web add @abyssvstar/dsh-side-chat
```

## Usage

| Where | Action | Result |
| --- | --- | --- |
| Below a finished turn | `◫` | Forks at that turn and opens the side chat |
| Empty right column | “Side chat · follow the main line” | Forks the latest finished turn |
| Empty right column | “Side chat · blank” | Creates a session with no inherited context |
| Inside a side chat | `↩` | Summarises the conversation and drafts it into the main composer |
| Any selection on the page | `↬` | Writes the selection into the side chat's composer |
| After closing a side-chat tab | Card: archive / keep | Archives the session or leaves it in place |

## How it works

**The session.** A side chat is created by `sessions.fork`. The host persists a prefix copy of the parent up to the branch point and records `parentSession` in the log header. From then on both sides append events independently.

**Reading the conclusion.** An out-of-tree plugin cannot append a model-visible custom event to a session log: persistence rejects logs whose event types are outside its known set, and the `ignorable` escape hatch is reserved for in-tree plugins and never reaches the model-visible surface. The browser half therefore reads through a host route:

```
GET /side-chat/handoff?child=<sessionId>&parent=<parentSessionId>
```

The host scans the child's log read-only through `sessionPersistence` and returns the last assistant message that carries text. A carry takes two steps: read the current answer as a baseline, trigger the side chat's summary, then poll that route until an answer different from the baseline appears and the turn has finished (two-minute cap, after which the baseline answer is carried).

**Writing the draft.** The conclusion is written into the main composer with `requestDraftInitialization`. When that call is unavailable the carry fails loudly rather than falling back to another channel.

**Blank side chats** go through `sessions.create` and therefore have no `parentSession`. Their address omits `parent`, so the carry-back action is absent rather than broken.

## Access control

Both routes are loopback-only in practice, but listening on loopback is not a permission check: any page the browser loads can try. Two cheap fences:

- **Origin.** A request whose `Sec-Fetch-Site` is neither `same-origin` nor `none`, or whose `Origin` is not this host, is refused with `403`.
- **Ownership.** The read route requires both `child` and `parent`, and refuses with `403` unless the log header's `parentSession` matches. Knowing a session id is not a licence to read its contents.

The write route additionally requires an `X-Side-Chat: 1` header. Cross-site forms and images cannot set custom headers, and a cross-site `fetch` that does needs a preflight this server never grants.

None of this is authentication — the GUI's own login is the only credential on the socket — and none of it stops a hostile local process. It stops a hostile web page.

## Known limits

- **A fork is always listed.** DSH has no hidden flag for sessions, and the supported alternatives cost more than they save: archiving makes a session unable to run a turn, and the subagent origin turns the composer read-only. The plugin settles for making rows distinguishable (a timestamped title) and asking whether to archive when the tab closes.
- **An archived side chat cannot be resumed.** That is DSH's own gate: an archived session is rejected before its first step. Archive only the ones you are done with.
- **The summary is a real model call.** A carry costs one extra call and one extra message, and the side chat reads as running while it happens; if it does not finish within two minutes the current answer is carried instead.
- **The host routes are optional.** Without a webserver (headless, tui) the panel still works and carry-back degrades to copy and paste.
- **Parentage is stored per browser.** The child-to-parent map lives in `localStorage` under `dsh.side-chat.v1`. After clearing storage or switching browsers, a fork is still recognisable through the catalog's `parentSessionId`, so carry-back keeps working.
- **The selection button is a document-level element.** A text selection is a browser fact rather than a session one, so the button is not a session-scoped seat; it hides itself when the selection sits inside one of its own panels.

## Compatibility

The plugin relies on seams that are not a public API: `ctx.get('agents')`, `ctx.get('sessionPersistence')`, `ctx.get('webServer')`, the client seats `conversation.chat.turnTail`, `sidebar.right.pane.tab` and its `.title`, `sidebar.right.tab.guide.entry`, and `requestDraftInitialization`. A DSH upgrade may move any of them.

```sh
npm run check    # same as: node scripts/check-dsh-compat.mjs <dsh-root>
```

The script asserts that each seam still exists in the installed DSH and names the one that broke. It is written against DSH 0.2.1-rc.2.

## Development and tests

```sh
npm test
```

Neither suite needs a browser: `test/client.test.mjs` evaluates the real `lib/client.js` against a stub runtime, and `test/host.test.mjs` drives both routes and the log scan.

## Documents

- [`docs/design.md`](docs/design.md) — design document: capability survey, extension points, milestones, and implementation revisions.
- Implementation details live in code comments.

## License

MIT
