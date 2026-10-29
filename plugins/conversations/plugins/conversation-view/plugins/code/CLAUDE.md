# code

## `edited-files`: paged by path, its totals a `Resolvable` meta

`editedFiles` (`core/resources.ts`) is a key-range-paged `liveValue` (query
`{ id }`): the worktree's edited files relative to its merge base, by path,
500 per page, a no-viewport read capped at `EDITED_FILES_MAX` (2000). Its
`editedFiles.meta` is the WHOLE set's totals (`count`, `additions`,
`deletions`) as a `Resolvable`. Readers go through `useEditedFiles` (web),
which joins the two into `Resolvable<{ files, summary, complete }>`:
`complete: false` when the files were cut at the cap (`summary.count` still
counts them all). One file by path — wherever it falls in the set — is the
`editedFile` value (`edited-files.file`, `useEditedFile`), the file-peek
pane's status hint.

## `[]` means *measured, and clean* — never *unknown*

The meta is `Resolvable<EditedFilesSummary>`, not a bare summary. That
distinction is decision-grade: `deriveExitMode` reads `summary.count` to arm
the destructive **Drop & Close** (and Go only when the `complete` file list is
all research docs), so an empty set must only ever mean a worktree we actually
measured and found clean.

A conversation with no `worktreePath`, and one whose worktree is reaped
mid-compute (`WorktreeGoneError`), are the same determinate state — no
trustworthy worktree to read. Both collapse onto `unresolved("worktree
unavailable")` through the local `onWorktree` helper (the pages are then
empty). Every page, the meta and the one-file value read the same memo
(`editedFilesMemo`), so they agree. Consumers cannot reach the files without
narrowing on `.resolved`, so the destructive default is unreachable by
construction.

Every *other* git failure still **throws**: that is a transient failure, and
live-state's readiness gate (`pending` = "no trustworthy value") makes it
un-absorbable. Do not convert one into an `unresolved(…)` — a retryable failure
that settles would stop retrying and would render as a permanent answer.

## One git pass per change: the watch is the freshness authority

`editedFilesMemo` is a `packages/watched-memo` keyed by worktree. While a
conversation shows it (`watchEditedFiles`), the checkout watch drives passes:
each is ONE status read (the facts: `readEditedFilesFacts` — `git status -unormal -z`
plus an `ls-files --others` of each untracked dir, entry for entry `-uall`'s at
a third of its walk) and ONE
`git diff -M -C -z --raw --numstat <merge-base>` over them
(`computeEditedFiles(wt, facts)`), and a loader run is a slice of the held list
with no git spawn. Every pass computes — never skipped on an equal signature (an
edit read mid-pass and undone would leave the list stale for good). The watch
is only as complete as what checkout-watch hears: every repo file `git status`
reads (the git dirs, the shared refs, `config`, `packed-refs`,
`info/exclude`), but not the global excludes file or global config — an edit
there shows on the next pass something else triggers. A watch that
lost events resyncs (one more pass). Unwatched (an HTTP read, plugin-changes) a
read probes the content signature (`editedFilesSignatureOf` over the facts it
read) and computes over those same facts on a miss — one status scan per miss.
The value is pushed, so no ETag is minted beside it; a revalidate would have to
return the held entry's own signature, never a fresh probe.

## The worktree: a followed row, and a watch that follows it

The pages, the meta and the one-file value each `follows` tasks-core's
`conversationWorkspaces` collection (`{ ids: [id] }`): every hook (`loader`,
`meta`, `whileFollowing.over`) is handed the conversation's workspace row
fresh (`followed.ws`, read through tasks-core's `conversationWorkspaceOf` —
the worktree path, and the workspace spec whose `git` capability is
asserted), the watch is started over the path alone, and the value's routes
are the collection's own. A
conversations/attempts write that touches no column the row carries (every
agent turn's status) re-runs no tuple; a conversation's insert, delete or move
re-runs only its own tuples (an attempt's `worktree_path` / `workspace` write:
that attempt's conversations). Read those tables any other way in a loader
and the drift guard reports it.

A conversation subscribed before its row exists has no worktree to watch, so
its watch watches nothing; the framework re-starts it over the new path when
a write moves it (the follow's re-point, `onFollowReached`) — so a worktree
written, or moved, after the first subscribe is watched. Every start
notifies once its watch is open, so a change between the load and the watch
going live is not lost. A (re-)start whose open fails is reported by the
runtime and retried at the next change reaching the tuple through its follow
(or the next subscribe), moved row or not.
`e2e/edited-files-cost.ts` measures all of it on a build.

## Desktop-only: `needsMachine`

`edited-files` is measured from git in the worktree on disk, so its declaration
is `needsMachine` and the values are served by `machine/` (`editedFilesServed`,
`editedFileServed`). Under a host without the computer (the in-browser demo)
`useEditedFiles` returns `{ status: "unavailable", message }` — never `[]`,
which would read as a clean worktree. The git reads (`getEditedFiles`, `editedFilesSignature`) stay
in `server/`: `review/plugin-changes` shares them, and follows the same
worktree watch (`watchEditedFiles`) from its own `machine/` — the paged value
cannot be a `recomputeOn` upstream (a keyed window cascades nothing, D32).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Meta plugin hosting code-related contributions for a conversation (edited files, viewer, etc.). Tracks edited files in the conversation's worktree via the live-state primitive: the git reads (getEditedFiles, editedFilesSignature) and the worktree watch (watchEditedFiles) other servers share. The live value is served by the machine half.
- Server:
  - Contributes:
    - `resource.declare` "edited-files"
    - `resource.declare` "edited-files.file"
    - `resource.declare` "edited-files:meta"
  - Uses:
    - `infra/git/checkout-watch.acquireCheckoutWatch`
    - `infra/host/host-read-pool.withHeavyReadSlot`
    - `primitives/commit-list.parseDiffRawNumstatZ`
    - `primitives/commit-list.runGit`
    - `primitives/commit-list.WorktreeGoneError`
  - Exports (values):
    - `editedFilesSignature`
    - `getEditedFiles`
    - `watchEditedFiles`
  - Resources:
    - `edited-files` (keyed, window, notified)
    - `edited-files:meta` (push, notified)
    - `edited-files.file` (push, notified)
- Web:
  - Uses:
    - `network/live.useLive`
    - `primitives/live-state.combineResources`
    - `primitives/live-state.mapResource`
    - `primitives/live-state.ResourceResult`
    - `primitives/live-state.ResourceUnavailable`
  - Exports (values):
    - `gitStatusBadge`
    - `gitStatusDot`
    - `useEditedFile`
    - `useEditedFiles`
- Machine:
  - Uses: `network/live.serveValue`
- Core:
  - Uses:
    - `network/live.liveValue`
    - `primitives/live-state.Resolvable`
    - `primitives/live-state.resolvableSchema`
  - Exports (types):
    - `EditedFile`
    - `EditedFilesMeta`
    - `EditedFilesQuery`
    - `EditedFilesSummary`
    - `EditedFileStatus`
  - Exports (values):
    - `EDITED_FILES_MAX`
    - `editedFile`
    - `editedFiles`
    - `EditedFileSchema`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/categorical --categorical-3`
    - `ui/tokens/categorical --categorical-5`
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --info`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/color-palette --warning`
  - Imported by:
    - `code-explorer/code-api`
    - `conversations/conversation-view/code/file-pane`
    - `conversations/conversation-view/push-and-exit`
    - `review/code-review`
    - `review/plugin-changes`
    - `review/plugin-changes/file-changes`
- Exemptions:
  - Exempts itself from:
    - `boundaries/no-platform-api` — `server/internal/compute-edited-files.ts`, `server/internal/edited-files-signature.ts` (debt)
    - `no-raw-websocket` — `e2e/edited-files-cost.ts` (sanctioned)
- Sub-plugins:
  - **`file-pane`** — Hosts the file-peek pane: a checkout file opened from a conversation (chat file links, review, commits), shown through primitives/file-viewer with the conversation's edited-file status as context.

<!-- AUTOGENERATED:END -->
