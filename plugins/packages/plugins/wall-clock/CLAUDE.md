# wall-clock

"The walk starts at 10h00 in Paris" → the UTC instant that is.

```ts
wallClockToInstant({ year: 2026, month: 8, day: 9, hour: 10 }, "Europe/Paris");
// 2026-08-09T08:00:00.000Z  — August is UTC+2, November would be UTC+1
```

**Why it exists.** This repo ships **no timezone database** — deliberately, and
documented in
[`event-date/CLAUDE.md`](../../../apps/plugins/events/plugins/event-date/CLAUDE.md):
stored calendar arithmetic is all UTC, so a series expands the same way on every
machine. The *edges* still meet local time — any source reading a foreign page
gets a clock-face reading with no offset attached and must turn it into an
instant. Three source types need exactly that, and DST arithmetic copied three
times is three chances to copy it slightly wrong.

**The Intl trick.** The platform already has the zone data, and `Intl` is the
only door to it that ships no table. `zoneWallClock` formats the instant *in* the
zone and rebuilds the clock face it printed; `zoneOffsetMs` diffs that face
against the instant — DST, half-hour zones and historical rule changes all
included, from ICU rather than from us. (`hour12: false` renders midnight as
`"24"` in some ICU versions, hence the `% 24`. A missing part throws: an
unresolvable zone must fail loudly, not read as UTC.) One formatter is kept per
zone, because building it is the expensive part and a single conversion reads the
zone three times.

`zoneWallClock` is exported because the read-back is wanted on its own — "what
day is it there?" — and every caller that hand-rolled it was one more copy of
the `% 24` and the throw-on-missing-part.

**Why it enumerates.** The offset depends on the instant, which is what we are
computing — a circular definition. It used to be solved by iterating: guess the
offset, correct, read back, correct again. That guess was wrong half the world
over. Which of the two candidate instants the second pass landed on turned out to
depend on the **sign** of the zone's offset, so both resolutions below held east
of Greenwich and silently inverted west of it — New York's skipped 02:30 came
back as 01:30, and Santiago's skipped midnight came back as 23:00 the *previous
day*.

So it enumerates instead. The offsets a day either side bracket every offset the
zone can have at that wall time, which gives at most two candidates — one per
offset — and each one is *verified* by reading its offset back: a candidate is an
answer only if the zone really has, at that instant, the offset it was built
from. Nothing is guessed, so nothing can come out wrong; a zone whose data this
does not model throws rather than returning an unchecked instant.

That leaves the two wall times where verification returns something other than
exactly one answer. Both resolutions are `Temporal`'s `compatible`:

- **Spring-forward gap.** 2026-03-29 02:30 Paris never happens (clocks jump
  02:00 → 03:00). No candidate survives, and the answer is 02:30 carried forward
  by the hour that was skipped — reading 03:30 on a Paris clock. A wall time at
  the very *start* of a gap therefore lands exactly on the jump, which is what
  makes a skipped midnight still the start of its own day.
- **Autumn overlap.** 2026-10-25 02:30 Paris happens *twice*, at 00:30Z and
  01:30Z. Both survive, and the answer is the **first**. Picking the second —
  which this used to claim, and delivered only east of Greenwich — breaks the
  day boundary in a zone whose clocks fall back onto midnight: Havana's
  2026-11-01 has two midnights, and the day began at the first.

Both are pinned by tests, in both hemispheres and both directions, and the rule
itself is swept across every 2026 clock change in seven zones rather than left to
a handful of hand-picked cities. A caller for whom the ambiguity matters should
not have a wall clock in the first place — it should be storing the offset its
source published.

**`startOfLocalDay`** is the one generic thing built on the pair: the date a
clock in the zone shows right now, at the earliest wall time that date has. It
needs no special case for either transition — a skipped midnight resolves to the
jump and a doubled one to the first, which is exactly what "when did today
begin" means.

**The month is 1-based** (1–12), as humans, ISO 8601 and every scraped page write
it. `Date.UTC`'s 0-based month is a real footgun; the API boundary is where it
gets named correctly, and the conversion happens once, in `utcMs`.

**`isRealWallClock`** builds the date and reads it back, because `Date.UTC` does
not reject 30 February — it rolls it into March. It is a *calendar* predicate: it
says nothing about DST, and 02:30 on a spring-forward morning is a real clock
face even though no instant matches it.

`wallClockToInstant` throws a plain `RangeError` on parts that are not a real
wall clock: this is a `core/` plugin with no dependency on `jobs`, so no
`NonRetryableError`. A domain caller pre-checks with `isRealWallClock` and raises
its own error — in `dmda`, a candidate year with no 29 February is the wrong
year, not a failure.

**Pure.** No `Date.now()`, no host-timezone read — so a test needs no clock and a
job gets the same instant on every machine. The per-zone formatter map is a memo,
not state: the same arguments give the same answer with or without it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Wall clock ↔ UTC instant for an IANA zone, without a timezone database: a wall time's candidate instants are enumerated from the offsets either side of it and each verified against Intl, so a clock change resolves the same way in every zone rather than by the sign of its offset. Also reads a clock face back out of an instant, and answers when the local day began.
- Cross-plugin:
  - Imported by: `primitives/metrics`
- Core:
  - Exports (types): `WallClock`
  - Exports (values):
    - `isRealWallClock`
    - `startOfLocalDay`
    - `wallClockToInstant`
    - `zoneOffsetMs`
    - `zoneWallClock`

<!-- AUTOGENERATED:END -->
