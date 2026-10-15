# sync-status

A **forced**, per-surface sync-status indicator — the Google-Keep cloud that
shows every optimistic / autosave surface's save state without any consumer
writing indicator code. Two halves the consumer never controls:

1. **Reporting is unforgeable** — it lives *inside* the sanctioned optimistic /
   autosave primitives (`useOptimisticResource`, `useEditableField`). Using the
   primitive means you report. Any surface can also call `useReportSync` directly.
2. **Rendering is unavoidable** — `<SyncStatusIndicator/>` is mounted once in the
   universal surface wrapper (`apps`' `TabSurface`), shared chrome no app owns.

```tsx
import { useReportSync } from "@plugins/primitives/plugins/sync-status/web";

// Inside an optimistic / autosave hook:
useReportSync({
  phase: failed.length ? "error" : saving ? "syncing" : "idle",
  label: "title",                       // optional — shown in the error state
  retry: failed.length ? retryAll : undefined,
  savedAt,                              // optional — your own "save completed" stamp
});
```

## What "Saved" guarantees

**`saving` means "the server hasn't acked this write yet" — nothing more.** The
cloud reports *durability*, not reconciliation:

- `syncing` ⇔ at least one write is still in flight (its `mutate` promise has not
  resolved). It is NOT "the client and server states have converged".
- `saved` ⇔ every write this reporter issued came back 2xx, and none failed. The
  bytes are durable. An optimistic overlay may still be replaying an acked op
  while it waits for the confirming push; that is invisible here, by design.
- `error` ⇔ a write genuinely failed and is retryable.

A reporter must therefore derive `phase` from its **unresolved / in-flight**
work, never from a queue that also holds server-acked entries. Getting this wrong
is what pinned `useOptimisticResource`'s cloud on "Saving…" forever: it counted
every overlay op, including ones the server had already absorbed. Two corollaries
worth stating: a save that round-trips in ~85 ms lands under the indicator's
120 ms show-delay, so the spinner mostly never appears at all; and with the
WebSocket down, a `saving` derived from ack (not from confirmation) still flips
to "Saved", because the write really did persist.

A local-first pipeline that queues bytes and retries (the collab-text
`doc-update` seam) reports `syncing` while its queue is non-empty — **including
while offline**, since the bytes are buffered and will flush on the next
reconnect edge. Offline is not `error`; only a real, non-retryable server
rejection is.

## `conflict` is a different axis, not a softer `error`

`conflict` ⇔ this reporter's copy and the server's have moved apart, and the
reporter is holding the user's unsaved version. Nothing failed and nothing is in
flight, so neither `error` nor `syncing` can say it: `error` promises a write
was rejected and a Retry exists, and retrying is meaningless here. The cloud
shows a warning sync icon and names the diverged fields; there is no button,
because the reporter — not the surface chrome — owns how to resolve it
(`useEditableField` keeps the draft and exposes `acceptExternal()`).

It outranks `syncing` in the aggregate: an in-flight save is routine, a
divergence is the thing the user has to know about. It does not outrank `error`,
which still has an action attached.

## Architecture

```
TabSurface
  PaneSurfaceProvider
    SyncStatusProvider                  ← per-surface scoped store (one per mount)
      {app content}                     ← reporters deep inside write via context
      <SyncStatusIndicator/>            ← Pin overlay, reads the aggregate
```

Each surface (incl. every floating window) gets its own isolated store via
`scoped-store`, so editing in one surface only lights up that surface's cloud.
Reporters write through plain React context — **no module-global registry, no
`surface-id` keying**.

## API

- **`useReportSync({ phase, label?, retry?, savedAt? })`** — declarative. Called
  every render with the current `phase`
  (`"idle" | "syncing" | "conflict" | "error"`), an
  optional `label` (the thing being saved), a `retry` thunk (only meaningful
  while `error`), and an optional `savedAt` timestamp. A stable id is minted with
  `useId()`; the entry is removed on unmount. **The reporter owns "saved"
  explicitly:** it sets `savedAt = Date.now()` the moment ITS OWN save completes
  and keeps reporting that same value thereafter; the store bumps `lastSavedAt`
  to `max(lastSavedAt, savedAt)` (drives "Saved"). This replaced the old
  store-side `syncing → idle` inference, which was lossy — a warm local socket
  can flip a transient `isSaving` boolean true→false inside one coalesced React
  render, so the store never observed `syncing` and never stamped a save. A
  persistent `savedAt` state value can't be coalesced away. The `retry` thunk is
  held in a ref so a fresh closure each render never thrashes the store — the
  indicator pulls it imperatively.
- **`SyncStatusProvider`** — thin wrapper over the scoped-store Provider; mount
  once per surface (already done in `TabSurface`).
- **`SyncStatusIndicator`** — the cloud. Reads the aggregate and renders pinned
  to the surface's bottom-right corner.
- Types: **`SyncPhase`**, **`ReportSyncArgs`**.

## Aggregate & precedence

The indicator collapses all active sources into one aggregate with precedence
**error > conflict > syncing > saved > idle**:

| aggregate | UI |
|---|---|
| `error`   | `MdCloudOff` (destructive) + "Couldn't save {labels}" + **Retry** (runs every error source's `retry()`) |
| `conflict`| `MdSyncProblem` (warning) + "{labels} changed elsewhere while you were editing" — no button |
| `syncing` | `Spinner` + "Saving…" (after a ~120ms show-delay, so fast saves never flash) |
| `saved`   | `MdCloudDone` (muted) + "Saved" (`RelativeTime` of `lastSavedAt` in the tooltip) |
| `idle`    | renders nothing |

`lastSavedAt` is `max` of every reporter's supplied `savedAt`, so the cloud shows
"Saved" once nothing is in flight, regardless of which reporter saved last.

## No-Provider tolerance

The sink the reporter writes through is carried on a context that **defaults to a
no-op sink**, separate from the scoped-store's own context (whose `useStoreApi`
throws when no Provider is above). So `useReportSync` is a harmless no-op outside
a `<SyncStatusProvider>` — the primitive stays usable in unit tests and
non-surface mounts instead of crashing.

## Invariants

- Only `syncing` / `conflict` / `error` sources are stored; `idle` removes the
  entry.
  `lastSavedAt` is bumped **only** by a reporter's explicit `savedAt` — a failed
  save never sets `savedAt`, so it never shows "Saved".
- `applyReport` returns the SAME `state` reference when neither the phase/label
  entry nor the computed `lastSavedAt` changed, so the scoped-store's `Object.is`
  bail prevents render loops (reporters re-report the same `savedAt` every render
  after a save).
- The reporter's apply effect has no cleanup (removing-then-reapplying on a phase
  change would drop the entry mid-flight); a separate unmount-only effect removes
  the entry.
- No contributions — a pure library primitive plus the one indicator component
  the surface wrapper mounts.
- **Stamp `savedAt` from the event that completed the save, not from an effect
  watching a derived boolean.** `useOptimisticResource` sets it inside its
  `mutate().then(...)` handler; a `useEffect` keyed on `isSaving` would miss the
  transition whenever React coalesces the `true → false` flip into one render —
  the same lossiness that killed the old store-side `syncing → idle` inference.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Per-surface forced sync-status indicator: optimistic/autosave surfaces report {phase,label,retry} via useReportSync; the universal SyncStatusIndicator (mounted once per surface) renders a Google-Keep-style cloud (saving → saved → error+retry). Scoped per surface via scoped-store; tolerates no Provider.
- Web:
  - Uses:
    - `primitives/css/pin.Pin`
    - `primitives/css/spinner.Spinner`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/overlay/tooltip.WithTooltip`
    - `primitives/relative-time.RelativeTime`
    - `primitives/scope/scoped-store.defineScopedStore`
    - `ui/icons.Icon`
  - Exports (types):
    - `ReportSyncArgs`
    - `SyncPhase`
  - Exports (values):
    - `SyncStatusIndicator`
    - `SyncStatusProvider`
    - `useReportSync`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --warning`
  - Imported by:
    - `apps-core/tab-surface`
    - `conversations/conversation-view/pending-turn`
    - `page/editor`
    - `primitives/editable-field`
    - `primitives/optimistic-mutation`

<!-- AUTOGENERATED:END -->
