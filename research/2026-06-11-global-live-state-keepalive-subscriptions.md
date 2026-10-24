# Keep-alive live-state subscriptions → delete ReorderHoist

## Context

The reorder list middleware (`plugins/reorder/web/internal/dnd-list-middleware.tsx`)
subscribes to config_v2 (`config-v2.values` + `config-v2.scope-forked`) once per
`<Slot.Render>`. When a reorderable slot is rendered **per row** in a list — e.g.
`JsonlViewer.RowAction` rendered for every message row in the jsonl-viewer — the
subscription fans out to one-per-row, "churning observe/unobserve on every row
mount/unmount."

The current patch is `ReorderHoist` (a provider wrapped manually around a row list
that hoists the one subscription so all rows share it). Adoption is **manual** —
only jsonl-viewer adopted it; tasks/task-list, agents, and conversation chips have
not, and nothing flags a per-row `Slot.Render` as a fan-out hazard. We want to
remove the manual opt-in.

### Why a generic keep-alive, not a reorder-specific hoist

Investigation showed the value is **already deduped** and the residual cost is
narrow:

- `useResource` is backed by TanStack Query, keyed by `queryKeyFor(key, params)`
  (`notifications-client.ts:87`). N rows reading the same slot's config resolve to
  **one cache entry** — no per-row fetch.
- The WS subscription is already **refcounted**: `observe()` sends a real `sub`
  only on the 0→1 transition (`notifications-client.ts:302-310`). At steady state,
  N rows = **1 server subscription** already, with or without `ReorderHoist`.

So `ReorderHoist` only buys: (1) avoiding observe/unobserve **churn** on row
mount/unmount, each firing `trace()` (a buffered `clientLog`) + `emitDebug()`
(a no-op unless the live-state-health pane is open, `:279`); (2) N TanStack
`QueryObserver`s, which only re-render on an **actual config change** (a
user-initiated reorder — rare); (3) N cheap `useConfig` hook-body executions.

The dominant cost is the churn (#1). Its root cause is generic, not
reorder-specific: React Query keeps the **cache entry** alive after the last
observer via `gcTime` (default 5 min), but the **WS subscription** lifecycle is
bolted onto a separate `useEffect` in `useResource` (`use-resource.ts:146-150`)
with **no gcTime equivalent** — `unobserve` tears down the sub immediately on
refcount 0 (`notifications-client.ts:328-329`). That mismatch is the churn.
`visibleEvents` is a filtered slice (`jsonl-pane.tsx:175`), so rows genuinely
mount/unmount as events stream and filters apply — the churn is real.

The modern/idiomatic fix is **observer-counted keep-alive**: defer the WS unsub by
a gc window so a transient unmount→remount reuses the live subscription instead of
tearing it down and rebuilding it. This fixes the entire class for **every**
live-state resource, and makes `ReorderHoist` unnecessary — it can be **deleted
with no replacement**.

## Design

### 1. Keep-alive (deferred teardown) in `NotificationsClient`

File: `plugins/primitives/plugins/live-state/web/notifications-client.ts`

- Add a per-channel `pendingTeardown: Map<string, ReturnType<typeof setTimeout>>`
  keyed by the same sub id (`` `${key}\0${pk}` ``).
- In `unobserve`, when `refcount` hits 0: **do not** immediately `subs.delete` +
  send `unsub`. Instead schedule a **one-shot** timer (`SUB_KEEPALIVE_MS`, e.g.
  `30_000`) that, when it fires, re-checks `refcount === 0` and only then sends
  the `unsub`, deletes the sub, and `emitDebug()`. Store the handle in
  `pendingTeardown`.
- In `observe`, on the refcount-bump path (existing sub found): if a
  `pendingTeardown` timer exists for that id, **cancel it** and clear the entry —
  the sub is alive again with zero WS traffic. (A sub in pending-teardown still
  lives in `channel.subs` with refcount 0; a new observe resurrects it via
  `refcount++`.)
- Reconnect edge (`replaySubs`, `:365`): pending-teardown subs (refcount 0) are
  still in `channel.subs`; resending them on reconnect is harmless (the timer
  still fires and tears down). Leave `replaySubs` as-is, or skip refcount-0 subs —
  document the choice. Recommend leaving as-is for minimal change.

This is a **one-shot debounce timer for deferred cleanup**, NOT a polling loop —
it mirrors React Query's own `gcTime` (which uses `setTimeout` internally) and the
existing debounce/ceiling timers in `config_v2`'s `ConfigWatcher`. It does not
violate the "no polling" rule (it checks nothing on a schedule); add a code
comment stating this explicitly.

### 2. Silence the churn trace

Same file. `observe`/`unobserve` currently `trace()` on **every** call including
refcount bumps (`:304`, `:323`). Gate the always-on trace to **transitions only**
(0→1 new sub, real teardown); make refcount-bump trace silent (or behind the
verbose flag). This removes the per-row `trace()` storm — the `live-state` log
channel is meant for low-volume transition lines (per `live-state/CLAUDE.md`), so
N-per-mount bumps violate that intent. `emitDebug` stays on transitions only
(already cheap).

### 3. Delete `ReorderHoist` (no replacement)

Once churn is gone, the per-row subscription is harmless (1 shared cache entry +
1 kept-alive sub + N cheap observers; the N observers re-render only on an actual
reorder, which happens with OR without the hoist). Remove the entire mechanism:

- **Delete** `plugins/reorder/web/internal/hoist-context.tsx`. Move the
  `ReorderHoistedConfig` interface (still the return type of `useReorderConfig`)
  into `dnd-list-middleware.tsx` (or a small local types file).
- `dnd-list-middleware.tsx`: remove the `ReorderHoistContext` import (`:41-43`)
  and the `hoisted` branch in `ReorderListMiddleware` (`:161`, `:173-184`) so it
  always renders `ReorderListMiddlewareInner` (the per-site path, now cheap).
  Delete `ReorderHoist` + `ReorderHoistInner` (`:693-748`). Keep `useReorderConfig`,
  `ReorderListMiddlewareInner`, and `ReorderInner` unchanged.
- `plugins/reorder/web/index.ts`: remove `export { ReorderHoist }` (`:18`).
- `plugins/conversations/.../jsonl-viewer/web/components/jsonl-pane.tsx`: remove the
  `ReorderHoist` import (`:13`) and unwrap (`:239`, `:249`), keeping `<EventSections>`
  and its children.

### 4. Docs

- `plugins/primitives/plugins/live-state/CLAUDE.md` — document keep-alive subscription
  semantics (WS sub lifetime now matches the query cache via a gc window;
  `SUB_KEEPALIVE_MS`).
- `plugins/reorder/CLAUDE.md` — remove `ReorderHoist` from the exports list; note
  that per-row reorderable slots no longer need any wrapper (subscriptions are
  shared + kept-alive at the live-state layer).
- `plugins/conversations/.../jsonl-viewer/CLAUDE.md` — drop `reorder.ReorderHoist`
  from the "Uses" list.

## Critical files

- `plugins/primitives/plugins/live-state/web/notifications-client.ts` — keep-alive + trace gating (core change)
- `plugins/primitives/plugins/live-state/web/use-resource.ts` — read only (observe/unobserve call sites unchanged; no edit expected)
- `plugins/reorder/web/internal/dnd-list-middleware.tsx` — strip hoist branch + delete ReorderHoist
- `plugins/reorder/web/internal/hoist-context.tsx` — delete
- `plugins/reorder/web/index.ts` — drop export
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx` — unwrap

## Verification

1. `./equin build` (regenerates docs; run `./equin check
   plugins-doc-in-sync` if docs drift).
2. App at `http://<worktree>.localhost:9000` — open a conversation with a long
   transcript (`/c/<id>` or `/a/<id>`):
   - Row actions (timestamp hover chip, raw-json) still render on every row.
   - Pen edit mode (toolbar pen) still reorders the row-action slot and the change
     persists across rows (writes are slot-global) and reload.
3. Churn check via the **live-state log channel**:
   `tail ~/.singularity/worktrees/<wt>/logs/live-state.jsonl` while scrolling /
   streaming a conversation — confirm there is **no** per-row
   `observe/unobserve … config-v2.values` storm (only transitions on
   pane mount/unmount).
4. Subscription-count check via the **Debug → live-state-health** pane — confirm
   the `config-v2.values` / `config-v2.scope-forked` subs for the reorder slot
   stay at a single entry (refcount > 1) and don't flap to 0 between row updates;
   confirm the sub survives ~`SUB_KEEPALIVE_MS` after navigating away, then tears
   down.
5. Regression sweep for keep-alive (it affects ALL resources): tasks list, agents
   list, and conversation sidebar still update live; navigating between
   conversations does not leak ever-growing subs (each tears down after the gc
   window).
6. `./equin check` (eslint incl. promise-safety/no-bare-catch on the new
   timer code; plugin-boundaries; doc-in-sync).
