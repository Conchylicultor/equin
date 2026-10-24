# Wall clock → instant: resolve DST gaps and overlaps by enumeration, not iteration

## Context

`wallClockToInstant(w, zone)` turns a clock-face reading into a UTC instant using
`Intl` (this repo ships no timezone database). Its documented contract names two
resolutions for the two wall times that have no single answer:

- a wall time inside a **spring-forward gap** never happens — the answer is the
  one past the gap;
- a wall time inside an **autumn overlap** happens twice — the answer is the
  second.

Neither holds west of Greenwich. The function guesses the offset, corrects, and
guesses again — two passes — and which of the two candidate instants the second
pass lands on depends on the **sign of the zone's offset**, not on any policy.
Measured against the current code:

| wall clock | zone | kind | returns | should return |
| --- | --- | --- | --- | --- |
| 2026-03-29 02:30 | Paris | gap | `01:30Z` = 03:30 local ✅ | 03:30 local |
| 2026-03-08 02:30 | New York | gap | `06:30Z` = **01:30 local** ❌ | 03:30 local |
| 2026-09-06 00:00 | Santiago | gap | `03:00Z` = **23:00 on the 5th** ❌ | `04:00Z` |
| 2026-03-08 00:00 | Havana | gap | `04:00Z` = **23:00 on the 7th** ❌ | `05:00Z` |
| 2026-10-25 02:30 | Paris | overlap | `01:30Z` = second ✅ | (see below) |
| 2026-11-01 01:30 | New York | overlap | `05:30Z` = **first** ❌ | (see below) |
| 2026-11-01 00:00 | Havana | overlap | `04:00Z` = **first** ❌ | (see below) |

So both documented resolutions are honoured only for positive offsets and
silently inverted for negative ones. Two of the four gap cases land on the
**previous day**, which is what makes this more than an edge case: anything
computing "start of the local day" or a scheduled local time on a transition day
gets an instant from the wrong day, with no error and no log.

Today there is one workaround: chord's `startOfLocalDay` detects the wrong-day
answer and re-derives it
(`plugins/apps/plugins/chord/plugins/progress/server/internal/local-day.ts`).
It only patches the gap half, and it is the only caller that noticed.

The outcome wanted: the primitive answers correctly in every zone, so the
workaround stops existing rather than being copied.

## The rule that replaces the guess

One sentence, for every zone and every wall time:

> **the instant at which the clock in `zone` reads `w` — the first of the two
> when the clocks read it twice, and `w` carried forward by the skipped amount
> when a clock change swallowed it.**

This is Temporal's `compatible` disambiguation. A wall time at the very start
of a gap therefore lands exactly on the jump, which is what makes a skipped
midnight still the start of its own day.

It is computed, not iterated. The offsets a day either side of the naive instant
bracket every offset the zone can have at that wall time, so there are at most
two candidates, and each one is **verified** by reading its offset back:

```ts
const naive = utcMs(fill(w));
const before = zoneOffsetMs(new Date(naive - DAY_MS), zone);
const after = zoneOffsetMs(new Date(naive + DAY_MS), zone);

// A candidate is real only if the zone really has that offset there.
const real = (before === after ? [before] : [before, after])
  .map((offset) => naive - offset)
  .filter((t) => zoneOffsetMs(new Date(t), zone) === naive - t);

if (real.length > 0) return new Date(Math.min(...real)); // one, or the earlier of two

// None: `w` is inside a gap. Held on the pre-jump offset it lands past the gap,
// carried forward by exactly the amount the clocks moved.
const atJump = naive - before;
if (zoneOffsetMs(new Date(atJump), zone) !== after) {
  throw new Error(`${zone} has no instant reading ${...} and no single jump over it`);
}
return new Date(atJump);
```

Every returned instant is now either checked to read `w`, or checked to sit on
the far side of the jump that swallowed it. There is no unverified guess left to
come out wrong, and a zone whose data the algorithm does not model fails loudly
instead of returning the wrong day.

## The overlap policy changes: second occurrence → first

This is forced, not incidental. `startOfLocalDay` asks for the first instant of
a local day, and in Havana on 2026-11-01 **midnight itself happens twice**
(`04:00Z` and `05:00Z`). A "second occurrence" policy returns `05:00Z` for a day
that began at `04:00Z` — an hour of that day silently excluded. Today's code
returns the first there only by the offset-sign accident described above; making
the documented policy actually hold would *break* chord.

Picking the first occurrence makes the two resolutions one coherent rule instead
of two unrelated choices, and it is what every current caller wants. The cost is
one hour of difference for a wall time inside the one ambiguous hour a year, at
call sites that read scraped Paris event times.

## Changes

### 1. `plugins/packages/plugins/wall-clock/core/internal/wall-clock.ts`

- Replace the two-pass loop in `wallClockToInstant` with the enumeration above.
  `isRealWallClock` pre-check and the `RangeError` stay as they are.
- Pull the `formatToParts` + `read()` block already inside `zoneOffsetMs` out
  into a private helper and export it as
  **`zoneWallClock(instant, zone): Required<WallClock>`** — the read-back
  direction. `zoneOffsetMs` becomes `utcMs(zoneWallClock(...)) - instant`, so
  there is still exactly one place that reads `Intl`. Three sites hand-roll this
  today (chord's `localDate`, chord's test `dateIn`, wall-clock's own test
  `parisClock`).
- Add **`startOfLocalDay(instant, zone): Date`**, three lines over the two above:
  read the local date, ask for its midnight. With the fixed conversion it needs
  no correction branch — a skipped midnight resolves to the jump, a doubled
  midnight to the first.
- Memoise the `Intl.DateTimeFormat` per zone in a module-level `Map`. Its
  construction is the expensive part, the conversion now makes three reads
  instead of two (four via `startOfLocalDay`), and the key set is bounded by the
  IANA zone names. Separable from the rest if you would rather keep the module
  free of state.

### 2. `plugins/packages/plugins/wall-clock/core/index.ts`

Export `zoneWallClock` and `startOfLocalDay` alongside the existing three.

### 3. chord loses its workaround

- Delete `plugins/apps/plugins/chord/plugins/progress/server/internal/local-day.ts`
  and `local-day.test.ts`.
- `…/progress/server/internal/progress.ts:20` imports `startOfLocalDay` from
  `@plugins/packages/plugins/wall-clock/core` instead of `./local-day`. Line 121
  is unchanged.

The two other callers —
`…/events/plugins/sources/plugins/dmda/server/internal/french-date.ts` and
`…/coworkmeet/server/internal/session-date.ts` — pass fully-specified Paris wall
clocks and never read one back. Neither file changes; only their answer inside
the October ambiguous hour moves, by an hour, to the first occurrence.

### 4. Docs

- `plugins/packages/plugins/wall-clock/CLAUDE.md`: replace *"Why it iterates"*
  with the enumeration and the one-sentence rule; rewrite both DST bullets
  (the overlap one now says first, and says why); document `zoneWallClock` and
  `startOfLocalDay`; drop the claim that a second pass suffices.
- `plugins/packages/plugins/wall-clock/package.json` description — it currently
  says *"iterated to a fixed point"*, which is the mechanism being removed. This
  string is what `docs/plugins-compact.md` and the umbrella `CLAUDE.md` carry,
  so `./equin build` regenerates them from it.
- `plugins/apps/plugins/chord/plugins/progress/CLAUDE.md:62` describes the
  day-boundary derivation and the removed helper.

## Tests

`plugins/packages/plugins/wall-clock/core/internal/wall-clock.test.ts`:

- Keep Paris's gap case (unchanged answer); update Paris's overlap case to the
  first occurrence, with the comment explaining the choice.
- Add the cases that fail today, each asserting both the instant and what a
  clock in that zone reads at it: New York gap (`2026-03-08 02:30` → `07:30Z`,
  reads 03:30) and overlap (`2026-11-01 01:30` → `05:30Z`); Santiago's skipped
  midnight (`2026-09-06 00:00` → `04:00Z`, reads 01:00 and is still the 6th);
  Havana's skipped midnight (`2026-03-08 00:00` → `05:00Z`) and its doubled
  midnight (`2026-11-01 00:00` → `04:00Z`); Lord Howe's half-hour overlap
  (`2026-04-05 01:45` → `14:45Z`, was `15:15Z`).
- A sweep that pins the rule itself rather than a handful of cities: over a list
  of zones (both hemispheres, both offset signs, a half-hour zone, a zone that
  jumps at midnight) × wall clocks stepped across each 2026 transition, assert
  the contract — away from a clock change the answer reads exactly `w` and is
  the first instant that does; inside a gap it is carried forward by exactly the
  amount the clocks skipped. The transitions are found by bisecting `Intl`, not
  by restating the conversion, so the sweep checks the contract rather than the
  implementation.
- Move chord's `local-day.test.ts` cases in (UTC, east, west, both transition
  days, the Santiago midnight jump, the "start is the first instant of the local
  day" property), adding the Havana doubled midnight — the case the old helper
  got right by accident and that the documented policy would have broken.

## Verification

```bash
./equin test plugins/packages/plugins/wall-clock
./equin test plugins/apps/plugins/chord/plugins/progress
./equin check                 # boundaries, type-check, plugins-doc-in-sync
./equin build                 # regenerates the plugin docs from the new description
```

Then, in the deployed app, chord's progress panel still reports today's counts —
it reads `startOfLocalDay(now, browserTimeZone)`, so this confirms the ordinary
(non-transition) path end to end:

```bash
./equin run plugins/apps/plugins/chord/plugins/curriculum/e2e/curriculum-verify.ts
```

A transition day cannot be driven from the UI without moving the clock, so the
sweep above is the real check: it asks `Intl` itself, for every zone in the
matrix, whether any earlier instant reads the requested wall time.
