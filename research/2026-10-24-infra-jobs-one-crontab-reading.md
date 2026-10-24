# One crontab reading for every host — drop graphile's private cron parser

## Context

`plugins/infra/plugins/jobs/machine/internal/cron-schedule.ts` deep-imports
`parseCronRangeString` from `graphile-worker/dist/cronMatcher` so the Background
catalog can describe a job's schedule ("Mondays 03:40 UTC") in graphile's own
terms. graphile-worker 0.18.0 is ESM-only with `"exports": "./dist/index.js"`,
so the deep path no longer resolves. That is what broke `regen-generated` in the
2026-10-19 deps upgrade (task-1792382409-wl0z9j). 0.18 doesn't publish the parsed
ranges either: `ParsedCronItem` exposes only `match`, and `cronMatcher.d.ts` drops
`parseCronRangeString`.

The repo already has **two** cron readings:

| reading | where | decides firing for |
|---|---|---|
| graphile's parser (private) | `graphile-worker/dist/cronMatcher` | the desktop (graphile cron loop), and the schedule *description* |
| `parseCrontab` / `nextCronFiring` | `jobs/core/cron.ts` | the in-process host (`jobs/plugins/in-process` memory queue) |

The deep import was there to stop a description from disagreeing with the
scheduler. With two parsers, though, the in-process host and the desktop can
already disagree with each other.

**Fix (rung 1, a disagreement that can't be written):** `jobs/core`'s
`parseCrontab` becomes the only crontab reading. The desktop gives graphile a
**matcher function** built from it. `CronItem.match: string | CronMatcher` is
public API in 0.16 and 0.18 (`parseCronItem` keeps a function as is). From then
on, graphile's cron loop, the in-process timer, the next-run estimate and the
plain-language description all read one parsed `Crontab`. Nothing touches
graphile internals, and graphile's own pattern grammar is no longer used at all.

## Design

### `jobs/core/cron.ts` — the one reading

Reshape `Crontab` to named, sorted, de-duplicated fields (this replaces both the
anonymous `sets` array and machine's `CronRanges`, so it stays one concept):

```ts
export interface Crontab {
  readonly expr: string;              // as declared (trimmed)
  readonly minutes: readonly number[]; // 0-59
  readonly hours: readonly number[];   // 0-23
  readonly dates: readonly number[];   // 1-31
  readonly months: readonly number[];  // 1-12
  readonly dows: readonly number[];    // 0-6, 0 = Sunday (7 folded into 0, then removed)
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

/** One UTC minute, in the shape graphile's TimestampDigest has. */
export interface CronDigest { min: number; hour: number; date: number; month: number; dow: number }

export function parseCrontab(expr: string): Crontab;        // throws on anything unreadable (unchanged contract)
export function cronMatches(tab: Crontab, d: CronDigest): boolean;
export function cronDigest(d: Date): CronDigest;             // UTC fields
export function nextCronFiring(tab: Crontab, from: Date): Date | null;
```

- Fix `dows`: 7 now *replaces* 0 instead of being added next to it, so the set
  is 0-6 as the words code expects.
- `nextCronFiring` stops probing minute by minute. It walks days (up to 366):
  skip a day whose month or day predicate fails, then take the first
  `hours × minutes` pair after `from` from the sorted arrays. A day costs O(1).
  That makes a year's lookahead affordable on every catalog list, so the
  machine's 8-day `LOOKAHEAD_MINUTES` cap goes away and one lookahead covers
  both hosts.
- `matches(tab, Date)` becomes `cronMatches(tab, digest)`, with the dom/dow OR
  rule unchanged. Only `core` defines `CronDigest`. graphile's `TimestampDigest`
  has the same shape, so tsc checks the hand-off at the worker call site and
  `core` never imports graphile.

### `jobs/machine/internal/worker.ts` — graphile runs our matcher

- `buildCronItems`: `const tab = parseCrontab(cron)`, then
  `parseCronItem({ …, match: (d) => cronMatches(tab, d) })`. An unreadable cron
  still throws at install. It now fails through our parser instead of graphile's.
- Keep a `Map<identifier, Crontab>` next to `scheduledCronItems`, rebuilt in the
  same place, so `nextScheduledRun` still means "what THIS backend installed"
  (main-only gating and resolver result included):
  `{ installed: true, next: nextCronFiring(tab, from), crontab: tab }`.
- Delete `machine/internal/cron-schedule.ts` (`cronRanges`, `CronRanges`,
  `nextFiring`) and their barrel exports.

### Background arm — describe the parsed crontab

- `provider.ts` `triggerOf`: use `parseCrontab(expr)` from
  `@plugins/infra/plugins/jobs/core`. Use the installed one from
  `nextScheduledRun` when available. It's the same parse either way, so parsing
  `expr` directly is fine for a job this backend didn't install.
- `cron-words.ts`: `cronWords(tab: Crontab)`. The fallback uses `tab.expr`, so the
  second parameter goes. "Every day" now comes from `!domRestricted` /
  `!dowRestricted` instead of "the array has 31 / 7 entries". That's the same
  predicate `cronMatches` uses, so the words can't describe a day rule the
  matcher doesn't apply.
- `cron-words.test.ts`: `words = (e) => cronWords(parseCrontab(e))`. Every
  existing case stays.

### Semantic deltas from graphile's grammar (deliberate, documented in `cron.ts`)

The `core` grammar is a superset of graphile's:
- it also accepts `a-b/n` and `n/step`
- a `5-5` range is accepted (graphile rejects `b <= a`)

One real difference: graphile treats a day field as unrestricted when it lists
every value (`1-31`). `core` decides by the text: the field is unrestricted only
when it is exactly `*`. This only matters when *both* day fields are restricted
in an unusual way. No schedule in the repo is affected: every declared cron is a
plain `m h * * *`, `m h * * d` or `0 4 1 * *`. Before the switch, a test asserts
that both parsers read every currently declared/default cron identically (see
Verification).

### The 0.18 bump (done in the same change, on request)

- `graphile-worker` ^0.16.6 → ^0.18.0. The only type break was the worker
  events now carrying a `ctx` (slot-ledger test fixtures). One worker is still
  one slot (`concurrency` workers of `concurrency: 1`), and the local queue
  (prefetch batching) defaults to off, so the fetch-time reservation holds.
  `add_jobs` (000020) differs from 000018 only in not consuming identity
  values.
- **Migration 000019 is a breaking-change marker.** A 0.16 worker refuses a
  database at revision ≥ 19, so a branch still on 0.16 whose DB is forked from
  main after main migrates cannot start its worker until it rebases.
- **0.18 warns "Your pool doesn't have error handlers!"** on our `createDbPool`
  pools and installs its own logging `error` / `connect` handlers. Whether
  `database/connection` should own those handlers is a follow-up.
- **`engines: node >=22.18`.** Our server and CLI run on Bun, and `bun install`
  doesn't enforce `engines`.

## Critical files

- `plugins/infra/plugins/jobs/core/cron.ts` (+ `cron.test.ts`, `core/index.ts` exports)
- `plugins/infra/plugins/jobs/machine/internal/worker.ts` (`buildCronItems`, `nextScheduledRun`)
- `plugins/infra/plugins/jobs/machine/internal/cron-schedule.ts` — deleted; `machine/index.ts` exports
- `plugins/infra/plugins/jobs/plugins/background-arm/machine/internal/{provider,cron-words,cron-words.test}.ts`
- `plugins/infra/plugins/jobs/plugins/in-process/server/internal/memory-queue.ts` — follows the API (no behaviour change)
- Comments that say "graphile's own parse": `cron-words.ts` header, `background-arm/CLAUDE.md`, `jobs/CLAUDE.md` (autogen sections regenerate on build)

## Verification

1. `core/cron.test.ts`:
   - existing next-firing cases, plus a year-boundary and a never-firing
     (`0 0 31 2 *`) case on the new day-walk
   - a property test that the day-walk equals a brute-force minute probe over
     random readable crontabs and start instants
   - dows fold (`* * * * 7` → `[0]`)
2. One-time parity test, before deleting the deep import while 0.16 is still
   installed: for every cron the registry declares, plus the configurable
   defaults (automation / backup), `parseCrontab` fields equal
   `parseCronRangeString`, and the restriction flags equal graphile's
   `length !== 31/7`. Then delete it with the import. The deep import exists only
   to support this test.
3. `./equin test plugins/infra/plugins/jobs` (core cron, cron-words,
   `run-identity.test.ts` which calls `buildCronItems`).
4. `./equin build`, then open Background on `http://<worktree>.localhost:9000`:
   scheduled jobs show the same words and a plausible next run. Check the worker
   log after a minute boundary to see that a `* * * * *` per-worktree job still
   ticks through graphile with the function matcher.
5. `rg 'graphile-worker/dist' -g '*.ts'` → only the boundary-test fixture string.
