# L2 persists are O(value) per change — bound the value, don't store rows

Attempt: att-1793868855-xe57dt (from the 2026-11-05 audit of main's slow
`INSERT … live_state_snapshot` upserts, task-1793850272; supervisor
task-1793826400-nd8if7). Status: **proposal, awaiting decision (D10)** —
nothing implemented.

## The mechanism

L2 (`network/live/live-state-snapshot`) keeps one row per persisted key in
`live_state_snapshot`, so a cold boot serves the value without a full read.
Every write rewrites the WHOLE value:

- **`floor` / `advance`** — a persisted `scopedMembership` alias (an unscoped
  `all` collection) arms one 2 s trailing window per scoped drain; on fire the
  value is rebuilt from the snapshot (`valueOfSnapshot`) and upserted whole.
- **`replace`** — every FULL recompute of a persisted entry. That includes a
  param-less `liveValue` declared `preload` and served `source: "db"`
  (`icons.saved-sprites`, `notifications.unread`): each change recomputes and
  upserts the whole value.

So the write cost per change burst is O(value), not O(changes), on both arms.

## What was measured

- **Main, 2026-11-05 (before the bounding chain):** `tasks` (6.0 MB JSON,
  ~1 MB compressed TOAST) and `attempts` (3.7 MB) were floor-persisted about
  every 6 s — ~67 TOAST chunks/s, ~8 MB/min of compressed TOAST, each upsert
  1–7.6 s with no event-loop stall (cost in Postgres: parse, pglz, TOAST, WAL
  on a loaded host). An isolated decompress+parse of both rows takes ~90 ms:
  the seconds are contention amplified by size.
- **Main, 2026-11-05 08:56 (after task-1793840384 → … and
  task-1793840393-mbyo0w landed):** `tasks` / `attempts` are bounded windows /
  scoped sets, never persisted. The 8 rows left:

  | key | JSON chars | stored bytes | arm |
  |---|---|---|---|
  | icons.saved-sprites | 79 K | 32 K | value (replace) |
  | conversations-active | 43 K | 9 K | alias (floor) |
  | saved-themes.list | 42 K | 10 K | value (replace) |
  | agents.roster | 33 K | 14 K | alias |
  | agent-launches | 9 K | 3 K | alias |
  | op-store.in-flight.all | < 1 K | < 1 K | alias |
  | notifications.unread | < 1 K | < 1 K | value |
  | conversations-system | 2 | 5 | alias |

  Today's cost is gone. The mechanism stays O(value) for any future large
  persisted key.

## What already bounds it

- Bounded windows, `:rows` point sets and scoped `all: { by }` sets are never
  persisted (`!membershipBounded(entry)`, scoped sets are never preloaded).
- Every `all` set declares exactly one of `max: N` (schema `.max(N)`, a load
  past it is a loud loader error) or `unbounded: { reason }`.
- Every list a value's schema reaches is `cappedList` / `wholeList`
  (`packages/list-bound`).

So the persisted set is already "whole sets and values" — but `unbounded` /
`wholeList` admit any size. Every persisted `all` set on main today is
declared `unbounded`.

## Options

1. **Per-row L2 storage for aliases** (a row per member, write only changed
   rows). Rejected for now:
   - Only fixes the alias arm; `replace` values stay O(value).
   - Rewrites the most delicate part of L2: the usable-row predicate, the
     definition / code stamps, per-key replay floors, `LEAST` / advance
     position rules, A30 validation and boot seeding — all of which assume one
     atomic row per key. Order would need its own storage (or re-derivation
     at seed).
   - The only beneficiaries are large persisted whole sets — exactly what the
     codebase converts into bounded windows (which L2 never persists).
2. **Make the persisted value bounded by construction** (recommended). The
   persist gate admits a key only when its value's size is bounded by its
   declaration: an `all` set declared `max`, a value whose schema lists are
   all capped. An `unbounded` / `wholeList` declaration is still served live,
   just not persisted: its cold boot does one full read (O(value) once per
   boot instead of once per change burst).
   - Rung: a declaration-level guarantee (tsc on `preload` + `unbounded`, or
     a check over the vocabulary), with the runtime's `shouldPersist` reading
     the same fact — never a size threshold measured at runtime.
   - Cost: the unbounded persisted `all` sets (`conversations-active`,
     `conversations-system`, `agents.roster`, `agent-launches`,
     `op-store.in-flight.all`) each choose a `max` (a loud failure past it) or
     give up instant cold boot; so do the persisted values with a whole list. `conversations-active`'s
     cap needs care: its readers need every live conversation.
3. **Leave as is.** Today's values are ≤ 80 K JSON; the risk only returns
   if a large whole set is declared and persisted again.

Not considered: a longer / size-proportional persist window — it lowers the
rate while hiding the O(value) cost (CLAUDE.md, *raising a limit*).

## Recommendation

Option 2, when the user decides D10. Until then nothing changes.
