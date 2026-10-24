# Prototype version history — a checkpoint per agent turn, ‹ › arrows in the UI

## Context

A prototype is one folder in `~/.singularity/apps/prototypes/<id>/`, host-global
and deliberately outside git. Each time an agent iterates on it, the previous
state is overwritten. So:

- the user cannot go back and look at what the mock looked like three turns ago,
  or undo a turn that made it worse;
- the next agent cannot see how the design got here — what was tried, in what
  order, and why.

Goal: **at the end of every agent turn that changed a prototype, record a
version.** In the prototype's detail pane, `‹ v3 of 7 ›` arrows step through the
versions, the stage (Focus, Compare, Present) shows the selected one, and a
**Restore** button makes an old version live again. Agents read the same history
as a diff log from the CLI.

Decided with the user:

- **Restore: yes.** Restoring first saves the current state, then writes the old
  files back and records a new "Restored v3" version. Nothing is ever lost.
- **Edits outside an agent turn** (hand edits, a plain terminal Claude): **fold
  into the next version.** Until then the arrows end on a "Live · unsaved
  changes" position. `./equin prototype checkpoint <id>` saves one by hand.

## Storage: one private git repo per prototype, in the app's own data dir

`~/.singularity/apps/prototypes/_history/<id>.git` — a bare repo whose work tree
is the prototype folder (`git --git-dir=<repo> --work-tree=<folder>`).

It lives inside the app's single data dir (`apps/prototypes`, declared by
`files`) — an app owns exactly one dir under `apps/`, so no new `defineDataDir`.
(Making that rule enforced rather than implicit is filed separately as
task-1789128735073-066i9z.) `_history/` sits beside `_template/` and is ignored
the same way: every reader of the tree — the gallery list, the reload
signature, the thumbnail sync — enumerates through `listPrototypeDirNames`
(`files/shared/read-folder.ts`), which already skips `_`- and `.`-prefixed
folders.

Why git, and why not the existing `history/engine`:

- **The engine is per-worktree DB with a 30-day TTL.** Prototypes are
  host-global: a version recorded by an agent's backend must be visible from
  main and every other worktree, and must outlive 30 days. A DB row in one
  worktree's forked database satisfies neither.
- **Git is what agents already read.** `log -p` is exactly "see the diffs and the
  evolution". Commits dedupe identical content, so storage is tiny.
- **Beside the prototype folder, not in it** because `prototypes:self-contained`
  rejects any subdirectory inside a prototype, the file route serves the folder
  flat, and the watcher/thumbnail fingerprint would otherwise see `.git` churn.

Repo hygiene: every git call runs with `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1`, `-c core.hooksPath=/dev/null -c commit.gpgsign=false`
and a fixed author, so the user's git config can never change behaviour. One
lock file per repo (`packages/flock`); a busy lock throws, and the job's retry
picks it up.

Each commit is one version:

```
<subject: first line of the user's request for that turn, ≤ 72 chars>

Request:
<the user's message for the turn, truncated>

Agent summary:
<the agent's final message for the turn, truncated>

Prototype-Kind: turn            # baseline | turn | restore | manual
Prototype-Conversation: <conversationId>
Prototype-Message: <messageId>
```

Versions are numbered by position: `v0` is the baseline (the blank template for a
new prototype; the state on first deploy for the existing ~19). The number is
derived (`rev-list --count`), never stored.

Backup comes free: the `prototypes` backup source already copies the whole
`apps/prototypes` tree, `_history/` included. The dir's existing `reclaim: never`
already covers it (it is the only copy of past versions). A deleted prototype's
history stays (harmless, and recoverable).

## Plugin layout

| Where | What |
|---|---|
| `prototypes/files` (owns the tree) | the version store, the baseline at mint, the per-prototype versions resource, serving a version's files, the restore endpoint, the CLI verbs |
| `prototypes/checkpoints` (new sub-plugin) | the end-of-turn job: which prototypes did this turn touch → record a version of each |
| `prototypes/gallery` (owns the detail pane) | the `‹ v3 of 7 ›` stepper, Restore, and pointing every stage at the selected version |

The turn job is its own plugin so `files` never depends on `conversations` —
`files` stays the low-level, CLI-importable owner of the tree.

### 1. `files`: the version store

`plugins/apps/plugins/prototypes/plugins/files/shared/history/` (Node-only, shared
by server and CLI — same split as `shared/mint.ts`):

- `historyRepo(id)` / `ensureHistory(id)` — `git init --bare` + baseline commit,
  idempotent under the lock.
- `checkpointPrototype(id, { kind, subject, body, conversationId?, messageId? })`
  → `{ kind: "recorded", sha, n } | { kind: "unchanged" }`. `add -A`, then
  commit only if `diff --cached --quiet` says something changed. When
  `messageId` is given and a commit already carries that `Prototype-Message`
  trailer, returns `unchanged` — the turn event is at-least-once (several
  backends can emit it for one turn), so recording is idempotent.
- `listVersions(id)` → `{ n, sha, at, kind, subject, conversationId?, messageId? }[]`
  plus `dirty: boolean` (`status --porcelain` against the folder).
- `readVersionFile(id, sha, file)` → bytes, via `git cat-file blob <sha>:<file>`
  (`spawnCaptured(…).stdoutBytes` from `infra/spawn`).
- `restoreVersion(id, sha)` — record a `manual` "Before restore" version if
  dirty, write the old tree back (checkout its files, delete files it does not
  have), record a `restore` version "Restored vN".

Hook points in `files`:

- `mintPrototype` (`files/shared/mint.ts`) calls `ensureHistory(id)` after the
  copy, so every new prototype starts with the blank template as `v0` — the first
  agent turn then shows as a full diff.
- On boot and in the watcher's refresh (`files/server/internal/watcher.ts`), any
  prototype without a repo gets `ensureHistory` — adopts the existing ones once.
- After every commit the store writes `_history/<id>.git/latest.json`
  (`{ n, sha }`). Git's own files have no extension, so they never pass the
  watcher's extension filter; this stamp is the one history file it does see
  (next section).

Server (`files/server`):

- **`prototypes.history` resource** — push resource with a `name` param (per-key
  params are allowed by the bounded-resource rule), value =
  `listVersions(name)`. Notified from the existing (and still only) watcher over
  `apps/prototypes`: a folder edit flips `dirty`; a `latest.json` change under
  `_history/<id>.git/` means a version was recorded — possibly by *another*
  backend (usually main) — and notifies that id only, without bumping the
  frame-reload version.
- The existing file route `GET /api/prototypes/:name/:file` refuses
  `_history`, so repo internals are never served.
- **`GET /api/prototypes/:name/versions/:sha/:file`** — a version's file bytes,
  `Cache-Control: immutable` (the sha addresses the content). Being a path
  prefix, a version's relative `styles.css` resolves to the same version.
- **`POST /api/prototypes/:name/versions/:sha/restore`** — `restoreVersion`.
- `prototypeVersionUrl(name, sha)` in `files/core/prototypes.ts` beside
  `prototypeUrl` — the one builder for the new route.
- Export `checkpointPrototype` from the server barrel for `checkpoints`.

CLI (`files/cli/index.ts`, new leaves under the `prototype` group, lazy imports):

- `prototype log <id> [-p]` — versions, newest first, with request/summary; `-p`
  adds each version's diff. Works with no backend running.
- `prototype checkpoint <id> [-m <msg>]` — record a `manual` version now.
- `prototype restore <id> <vN|sha>` — same as the button.

### 2. `checkpoints`: the end-of-turn job

`plugins/apps/plugins/prototypes/plugins/checkpoints/server/`:

```ts
contributions: [Trigger({ on: conversationTurnCompleted, do: checkpointTurnJob, with: {}, oneShot: false })]
```

Same shape as `conversation-progress/server/index.ts`. The job, given
`{ conversationId, messageId, text }`:

1. Reads the conversation's transcript
   (`resolveConversationTranscriptPaths` + `readJsonlEventsFromChain` from
   `conversations/transcript-watcher/server`).
2. Takes this turn's window: events after the previous end-of-turn assistant
   message, up to `messageId`.
3. **Which prototypes did the turn touch:** every prototype id
   (`PROTOTYPE_ID_RE` from `files/core`) found in the inputs of the window's
   `tool-call` events — `Edit`/`Write` file paths, `Bash` commands, and an
   `Agent` call's prompt (so work delegated to a subagent is caught). Keep ids
   whose folder exists.
4. Records a `turn` version of each via `checkpointPrototype`. Subject/body come
   from the window's user message and the turn's final `text`. A touched
   prototype with no actual change records nothing.

Attribution comes from the transcript, not from "whatever is dirty", so an agent
finishing its turn never snapshots a *different* agent's half-written prototype.
A change nothing claims simply waits (shown as "Live · unsaved changes") and is
included in the next version.

### 3. `gallery`: the stepper

State: `PrototypeDetailProvider` (`gallery/web/context.tsx`) gains
`shownVersion: string | null` (a sha; `null` = live) and `showVersion(sha|null)`.
It resets when the prototype changes.

`usePrototypeSrc` (`context.tsx:143`) is already the one URL seam used by Focus,
Compare's mock half, and Present (overlay and new tab). With a version selected
it returns `prototypeVersionUrl(name, sha)`. So all three stages show the
selected version with no change of their own.

A past version keeps its own options. *(Revised 2026-09-15 — the first cut
hid the picker and rendered a past version at its defaults, which made a
variant the live page had since dropped impossible to see again.)* Each
`PrototypeVersion` carries the options its own `index.html` declares, the
picker offers those, and the version file route stamps picks exactly like the
live route, judged against that version's declaration.

`VersionStepper` — a zero-prop contribution to `prototypeDetailPane.Actions`,
next to the stage switcher (`gallery/web/components/detail-actions.tsx`), reading
`prototypes.history` for the prototype:

- `‹  v3 of 7  ›` — icon buttons, disabled at the ends. The right end is
  "Latest". If the folder is `dirty`, one more position past the last version:
  "Live · unsaved changes".
- Tooltip on the label: the version's request line and when it was made
  (`RelativeTime`). Clicking the label opens a popover listing every version
  (a `data-view` list — domain records): request line, time, and a link to the
  conversation that made it. Picking a row jumps to that version.
- While a past version is shown: a **Restore** button (a `confirmDialog`, then
  the restore endpoint) and a "Back to latest" affordance.
- Keyboard: `[` / `]` step back/forward via `defineShortcut`, scoped to the pane.
- Loading state while the resource is pending (never "0 versions").

Improve prompt (`detail-actions.tsx:improveText`): add one line pointing at
`./equin prototype log <id> -p`. If the user launches Improve while
looking at an old version, the prompt says which one ("the user was viewing v3,
<sha>") — they may want to build from there.

### 4. Docs

- `prototypes/CLAUDE.md`: a short "History" section — every agent turn that
  changes the folder records a version automatically; read the evolution with
  `prototype log <id> -p`; never create a `.git` in the folder.
- Plugin CLAUDE.md prose for `files` (the store) and the new `checkpoints`.

## Critical files

- `plugins/apps/plugins/prototypes/plugins/files/` — `shared/mint.ts`,
  new `shared/history/*`, `server/index.ts`,
  `server/internal/{watcher,resources,handlers}.ts`, `core/prototypes.ts`,
  `cli/index.ts` + new `cli/{log,checkpoint,restore}.ts`
- new `plugins/apps/plugins/prototypes/plugins/checkpoints/` (server barrel + job)
- `plugins/apps/plugins/prototypes/plugins/gallery/web/` — `context.tsx`,
  `components/detail-actions.tsx`, `components/prototype-detail.tsx` (hide
  picker), new `components/version-stepper.tsx`
- `prototypes/CLAUDE.md`

Reused: `prototypesDir` + `listPrototypeDirNames` (files), `spawnCaptured` + `GIT` (infra/spawn,
infra/paths), `packages/flock`, `createFileWatcher` (infra/file-watcher),
`Trigger` + `conversationTurnCompleted` (infra/events, conversations),
`readJsonlEventsFromChain` / `resolveConversationTranscriptPaths`
(transcript-watcher), `PROTOTYPE_ID_RE` (files/core), `confirmDialog`,
`RelativeTime`, `data-view` list.

## Verification

- **Unit tests** (`./equin test plugins/apps/plugins/prototypes`):
  - version store against a temp dir: baseline, record, unchanged-is-a-no-op,
    duplicate `messageId` is a no-op, `dirty`, read a version's file (text and
    PNG bytes), restore (file added since, file deleted since, dirty before
    restore ⇒ "Before restore" version).
  - turn attribution: a fixture event list → the right ids from Edit, Bash and
    Agent inputs; a window boundary at the previous end-of-turn; ids of other
    prototypes mentioned *before* the window are ignored.
- **End to end:** `./equin build`, then mint a prototype, launch Improve,
  let the agent do two turns. `./equin prototype log <id> -p` shows v0 plus
  two versions with their requests and diffs. In the detail pane, `‹` goes back
  one version and the frame shows the older mock (screenshot with
  `e2e-harness/e2e/screenshot.ts --path /prototypes/proto/<id> --click …`);
  Compare and Present show it too. Restore v1 → a new version appears and the
  live file matches v1. Hand-edit the file → "Live · unsaved changes" appears.
  `_history` never shows as a gallery card or a "not a prototype id" problem,
  and `/api/prototypes/_history/…` returns 404.
- `./equin check` (data-dir registry, boundaries, self-contained check,
  docs in sync).
