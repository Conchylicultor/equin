# op-status

Surfaces the worktree's in-flight long-running operation (build / push / check /
test / e2e) in two places:

- a **banner** above the prompt input, and
- a compact **sidebar row chip** (one icon per kind, an hourglass while parked
  in a wait), so an op is visible from the conversation list without opening
  the conversation.

A web-only plugin: it reads the op-store's `opsInFlight` live collection
(`debug/profiling/op-log/plugins/op-store/core`) — the DB fold of `op-log.jsonl`
— and owns no server state. Plan:
`research/2026-09-29-global-unified-op-status.md` §6.

## How it works

- **One subscription.** `useOpsInFlight()` is `useLive(opsInFlight)`, an
  `all` collection (`op-store.in-flight.all`) — every in-flight op on the host,
  however many, boot-preloaded so the banner and chips paint settled. The banner and every chip share it and filter by
  worktree slug on the client (`opSlugOf(row)`: `opSlug`, else the last
  segment of a legacy line's branch). The slug of a conversation is
  `basename(worktreePath)`.
- **Which op a worktree shows** (`opsOfSlug`): by `OP_RANK` (push > check >
  build > test / e2e), then oldest. The banner adds `+N others` for the rest of
  the host's in-flight ops.
- **The state line** (`stateLine`, `web/internal/op-lines.ts`) is the one
  wording every surface renders:
  - parked in a wait (`openWait != null`): `{Kind} — {WAIT_KINDS[kind].sentence(reason)}`,
    `· requeue #N` when the wait's cycle is past 0, then the wait's own clock —
    e.g. `Build — held: host under duress (loadRatio) · requeue #6 · 12:03`;
  - working: `{Kind} — {progressive}` (`Build — Building`).

  The right side is the op's total elapsed. The banner's **warning tone means
  "parked in a wait"**, before the grant or after it (a build waiting on the
  duress valve after its lock is as stuck as one waiting for the lock).
- **The expanded list** is a DataView (`conversations.op-status.queue`, one
  compact table view grouped by `section`, authored in
  `config/conversations/conversation-view/op-status/`). The banner card is the
  DataView's **hosted toolbar frame** (`OpStatusCard`): the header line folds
  the list and, while expanded, carries its one options trigger (search,
  filter, sort); the op, clock and fold state reach the frame through
  `BannerChromeContext`. `buildSections` stays the order authority — the
  section holding this worktree's op first, then `OP_KINDS` order — and is
  flattened into rows in that order (the config's sort is `[]`, and the
  `section` enum lists its options in section order, so groups follow it). The
  **Push queue** section reconstructs the global queue with positions: `1` the
  push holding the mutex (`grantedAt` set), then the pushes parked on the mutex
  by `openWait.startedAt`, then any push not at the mutex yet. Every other
  section reads working → held → queued, then by `requestedAt`. Columns: a
  phase glyph (`phaseOf`: spinner = working, hollow dot = **queued** in an
  ordinary line, warning hourglass = **held** by the duress valve — the one
  phase that also says so in words, in its own column), the push position, the
  title, and **waited** / **worked** (`liveTimes`), plus an **asleep** clock
  that is hidden by default (`visible: false`, like `section`) and revealed from
  View options → View settings → Properties. Only the clocks have column
  headers (`FieldDef.header: false` on the rest), placed once on the first
  section header (`columnHeader: "first-group"`). The title cell's tooltip is
  the full state line and split — `waited … · worked … · asleep …`, the asleep
  part only when the op slept. The current worktree's op is the selected
  (highlighted) row; titles come from `useConversationTitleBySlug()`
  (`conversations/web`), falling back to the slug. Activating a row opens the
  op detail pane (`debug/profiling/ops`); the hover action opens another row's
  conversation.
- **The chip** (`Item.Chips`) reads the same subscription through
  `useWorktreeOp(conversationId)`, a `ResourceResult<OpRow | null>`: loading or
  failed never reads as "idle". It shows the hourglass whenever the op is
  parked in a wait, else the kind's icon (wrench = build, up-arrow = push,
  flask = check, checklist = test, open-in-browser = e2e); the tooltip is the
  state line, ticking only while the tooltip is open.
- **Clocks** are a presentational 1 s `useNow` ticker; the op state itself is
  pushed by the change feed on `op_log_ops`. Every clock goes through
  `timesOf(row, now, sleepNow)` / `stateLine(row, now, sleepNow)`, where
  `sleepNow` is the machine's sleep clock (`useSleepNowForFold()`,
  `infra/host/plugins/machine-sleep/web`; `null` = unknown while it loads): a
  nap — recorded, or since the op's last event — is **asleep, never worked**,
  and is excluded from an open wait's own clock too.

The kinds, nouns and busy verbs are `OP_KINDS` (`infra/worktree/core`); the
chip's `Record<OpKind, IconRef>` and `OP_RANK` are type errors until a new kind
has an entry.

## Verifying it end to end

`e2e/op-status-waits.ts` drives a synthetic op through the real writers and
asserts what the banner, the sidebar chip and the op detail pane show at each
state (parked on the duress valve at requeue #2 → working → completed, then a
SIGKILLed op with no terminal). The op is `scripts/synthetic-op.ts`, a separate
process, because an `e2e` script may not import `server` barrels and because
killing a real process is the honest way to test a death. Its steps are driven
by a control file it watches. The interrupted close of the killed op is appended only by MAIN's
reconciler, so that assertion runs only with `--main-reconciles`; without it the
script says so, skips it, and closes the dead op through the helper's `close`
mode (the reconciler's own terminal event) so no dead row lingers.

`e2e/op-sleep.ts` asserts the sleep accounting: the helper's `run-asleep` mode
writes a build whose events carry sleep stamps from a fake boot (a 2 h nap,
woken inside the gap, so placed exactly — without sleeping the machine), and
the script checks the row tooltip (worked ≈ 10 min, `asleep 2:00:00`), that the
Asleep column is hidden by default and revealable (then restores the default
with Show all fields), and the op detail's Asleep stat and hatched overlay. The
spawn / control-file / banner helpers both scripts share are `e2e/synthetic.ts`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Banner above the prompt input showing the worktree's in-flight op (build / push / check / test / e2e) from the op-store in-flight collection: the wait it is parked in (reason, requeue cycle, its own clock) or the work it is doing, total elapsed and the waited / worked split, expandable into a grouped table (DataView) of the global push queue and every other in-flight op, each row opening its op detail pane. Also a sidebar row chip flagging the same op (hourglass while parked in a wait).
- Web:
  - Slots: `queue-actions`
  - Slot contributors: `queue-actions` ← `conversations.conversation-view.op-status`
  - Contributes:
    - `Conversation.AbovePromptInput` → `OpStatusBanner`
    - `Item.Chips` → `OpStatusChip`
    - `FieldPresentation.Register` "collection:op-status.queue-row"
    - `queue-actions` "open-conversation" → `OpenConversationAction`
  - Uses: 38 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/data-view` ×6
    - `primitives/live-state` ×5
    - `conversations/conversation-view` ×2
    - `conversations` ×2
    - `network/live` ×2
    - `primitives/css/fill` ×2
    - `primitives/css/ui-kit` ×2
    - `primitives/relative-time` ×2
    - `conversations/conversation-ui/item.Item`
    - `debug/profiling/ops.opDetailPane`
    - `infra/host/machine-sleep.useSleepNowForFold`
    - `primitives/collapsible.FoldMotion`
    - `primitives/css/clip.Clip`
    - `primitives/css/inline.Inline`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/text.Text`
    - `primitives/icon-button.IconButton`
    - `primitives/link-gesture.activationProps`
    - `primitives/pane.useOpenPane`
    - `ui/icons.Icon`
- Core:
  - Uses:
    - `fields.nullable`
    - `fields/bool/config.boolField`
    - `fields/float/config.floatField`
    - `fields/int/config.intField`
    - `fields/text/config.enumTextField`
    - `fields/text/config.textField`
    - `network/live.rowKind`
  - Exports (types): `OpRowPhase`
  - Exports (values):
    - `OP_ROW_PHASES`
    - `opQueueRow`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --chrome-pad-x`
    - `ui/tokens/density --op-status-icon`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-medium`
    - `ui/tokens/type-scale --font-weight-normal`

<!-- AUTOGENERATED:END -->
