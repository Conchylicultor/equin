# By-id row reads: absent is not loading

Task: task "Surfaces stay loading forever when their row is missing" (replaces
task-1790505193580-sdqzrv).

## Context

A by-id row read (`useLive(c, { id })` → `LiveRowResult`) has four arms:
loading, error (maybe a stale row), found, not found. Two surfaces collapse
"not found" into "loading" and spin forever once the row is deleted:

- `conversations/agents` `AgentDetail` — `mapRow(r, row => row)` then
  `if (!agent) return <Loading />`. The detail pane is guarded by
  `useResolve: resolveRow(...)`, but the agent **side** pane
  (`agentSidePane`, `useResolve: false`) is not, so a deleted agent spins.
- `useConversationById(id): ConversationEntry | null` — loading, absent and
  failed-before-seen are all `null`. The review pane (a satellite, unguarded)
  draws its push tabs `pending` and `CodeReviewSection` / `FileChangesSection`
  render `<Loading/>` on that `null`: forever for a deleted conversation.
  ~45 callers share the ambiguity.

A correct sibling already exists: `useConversation(id):
ResourceResult<ConversationEntry | null>` (ready `null` = no such
conversation).

## Design

### 1. The read (rung 1 — the collapsing spelling is deleted)

`useConversationById` now returns the read itself:
`LiveRowResult<ConversationEntry>` (it is `useLive(conversationsById, { id })`).
The name stays (a by-id read of a conversation), the type changes, so tsc
forces every caller to pick its arms. No new concept: `LiveRowResult`,
`rowOrStale`, `resolveRow` and `mapRow` already exist.

Each caller is one of:

- **Under the conversation pane's resolve guard** (conversation-view toolbar
  chips, transcript tool views, artifacts, title prefix…): the guard paints
  Loading / error / Not Found, so the body's sanctioned reduction is
  `rowOrStale(useConversationById(id))` — the pane primitive's existing,
  documented helper for exactly this contract. Behaviour unchanged (same
  stale-on-error).
- **Unguarded** (review pane + its sections, explorer / push-profiling /
  commits-graph satellites, active-data chips in transcripts, task header
  author, health-report browser row, conversation row, file-links provider,
  pane title hook): switch on the arms — absent renders a "no such
  conversation" placeholder (panes/sections) or the id/neutral fallback it
  already had (chips/rows); loading keeps its loading state; error renders
  `ResourceErrorInline` where the surface is a pane/section.

### 2. AgentDetail

Switch on the row read directly: loading → `<Loading/>`, error (no stale) →
`ResourceErrorInline`, not found → `Placeholder` "This agent no longer
exists.", found (or stale) → the detail. Correct under both panes, no reliance
on the guard.

### 3. The rule (rung 3) — `live/no-row-absence-collapse`

Syntactic, in `plugins/network/plugins/live/lint/`. Flags the hand-written
reduction of a row read to one nullable value, where loading and absent come
out the same:

- `X.status === "ready" && X.found ? <value> : null|undefined`;
- `X.found ? <value referencing X.row> : null|undefined` in a function where
  the `loading` arm of `X` (a `case "loading":` of `switch (X.status)`, or
  `if (X.status === "loading" | !== "ready") return …`) returns a
  null/undefined literal too;

…when `<value>` is not JSX (a component rendering nothing for both is a render
choice, not an exported ambiguity). Plus the render form that bit AgentDetail:

- `<Loading …/>` returned/rendered from the consequent of `!X.found`, or of a
  falsy test on the parameter of a ready callback (`ResourceView` children,
  `matchResource`/`foldResource` `ready`) — the read has answered; drawing it
  as loading is the spinner-forever bug.

Sanctioned spelling for a guarded body or a title: `rowOrStale` (pane), exempted
by `primitives/pane/exempt` as `sanctioned`. Existing hand-written copies
(debug panes' title hooks, `seenPage`, `shownRun`, use-conversations) are
migrated to `rowOrStale` or to arm-handling. `noDebt`: the rule ships with no
debt entries.

## Trade-offs (decided)

- Keep the `useConversationById` name with a new type rather than deleting it
  in favour of raw `useLive(conversationsById, …)`: same churn for callers,
  and they keep importing from `conversations/web`.
- The lint is syntactic (like `no-pending-data-collapse`), not type-aware: it
  will miss a collapse spelled through a helper. The type change in §1 is the
  load-bearing fix for conversations; the rule guards the next hand-written
  copy.
- Satellite panes of a conversation are treated as unguarded (the task's own
  symptom shows the parent guard does not cover them).

## Verification

- `./equin test plugins/network/plugins/live` (new rule's RuleTester suite).
- `./equin check` (type-check runs the new rule repo-wide: zero hits after
  migration).
- `./equin build`, then in the browser: open an agent in the side pane and
  delete it → "no longer exists"; open a conversation's Review pane with an
  unknown conv id → placeholder, not a spinner.

## As landed

- **`RowView`** (`network/live/web`): `<RowView row missing fallback? subject?>`
  — the `ResourceView` of a row read, `missing` required (a stale row on a
  failed re-read keeps rendering). Used by `AgentDetail`, the review pane and
  its sections, and the push-profiling / commits-graph satellites.
- **`rowOrStale` moved** from `primitives/pane` to `network/live/web` (next to
  `mapRow` / `RowView`): it is the sanctioned reduction for any surface that
  renders the same truthful thing for loading and absent — guarded bodies,
  titles, chips — not only pane bodies. Its file is the rule's one
  (sanctioned) exemption; the rule is `noDebt`.
- **The rule** only flags the un-gated form when the conditional is the
  function's returned value (a component assigning `found ? row : undefined`
  after rendering `null` while loading is a render choice).
- **17 existing collapses** the rule found were migrated: hand copies of
  `rowOrStale` (`shownRun`, `seenPage`), five pane title hooks, crumbs and
  chips, and one deploy body drawing `<Loading>` on `!found`.
- `conv-chip` drew the "gone" dot while its read loaded; it now draws it only
  on `found: false`.
- The build's `plugins-doc-in-sync` failure hit along the way (token-usage
  attributing classes across the scan batch) was fixed on main in parallel
  (27afec7984); this branch takes main's fix.
