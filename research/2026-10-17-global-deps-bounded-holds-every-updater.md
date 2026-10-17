# Bounded holds for every updater: one hold model for npm, mise and uv

Status: **plan**. Follows up on [2026-10-16-global-deps-versions-always-move.md](./2026-10-16-global-deps-versions-always-move.md) §B.

## Context

That plan bounded only the new npm **range** holds (`dependencyPolicy.holds`: required `until`, at most 90 days out, inert on expiry, checked by `deps-npm:policy`). It left the single-release `UpdaterHold` unbounded on the grounds that "it expires on its own: the next release moves past it". That argument is weak:

- A release that ships *and then nothing newer for months* stays held for months, with nobody re-checking it.
- A hold that has stopped mattering is never deleted, because nothing ever flags it. `UV_HOLDS` holds CPython 3.15.0 "until torch 2.15 (GA 2026-10-28)". Nothing will remind anyone to remove it.
- mise and uv **drop** a held release from `detect()` without a word. npm reports it as `waiting: { kind: "held", reason, until }`. A hold is supposed to stop *landing*, never *seeing*, and two of the three updaters break that rule.

Three hold shapes exist today:

| updater | where | shape | bounded | held row visible |
|---|---|---|---|---|
| npm | `package.json` `dependencyPolicy.holds` (`npm/core/internal/policy.ts` `HoldSchema`) | `packages[]`, `version`\|`below`, `reason`, `issue?`, `until` | yes (`deps-npm:policy`) | yes |
| mise | `plugins/toolchain/core/internal/tools.ts` `HOLDS: ToolHold[]` (empty) | `tool`, `version`, `reason`, `issue` | no | no (filtered out in `detect`) |
| uv | `uv-updater.ts` `UV_HOLDS: UpdaterHold[]` (1 entry) | `name`, `version`, `reason`, `issue` | no | no (`isHeld` skips it) |

**Goal:** the three updaters share one hold model, and every hold has an expiry: a required `until` at most 90 days out, after which the hold is inert, and a held release is always reported.

## Design

### 1. One `Hold` in `infra/deps/updates/core` (the updater contract)

New `plugins/infra/plugins/deps/plugins/updates/core/internal/hold.ts`. Its content moves up from `npm/core/internal/policy.ts`, then gets generalised:

```ts
export const HOLD_MAX_DAYS = 90;

/** Releases of `names` not to land yet: one broken `version`, or everything from `below` up. */
export const HoldSchema = z.object({
  names: z.array(z.string().min(1)).min(1),
  version: z.string().min(1).optional(),
  below: z.string().min(1).optional(),
  reason: z.string().min(1),
  issue: z.string().url().optional(),
  until: z.string().regex(DAY, "a YYYY-MM-DD day"),
}).strict().refine(exactlyOneOf version/below);
export type Hold = z.infer<typeof HoldSchema>;

export function utcDay(now: Date): string;
export function holdActive(hold: Hold, today: string): boolean;    // until >= today
export function latestUntil(today: string): string;                 // today + 90d
/** The active hold covering `name@version` on `today`, given the updater's own version order. */
export function heldBy(holds, name, version, today, compare: (a, b) => number): Hold | undefined;
/** Holds set past latestUntil(today), and malformed ones, as check messages. */
export function holdProblems(holds: readonly Hold[], today: string, where: string): string[];
/** The `waiting` of a held row: { kind: "held", reason, until }. */
export function heldWaiting(hold: Hold): OutdatedWaiting;
```

- `UpdaterHold` and `ToolHold` are deleted. Every hold everywhere is a `Hold`, and `until` is a required field, so `tsc` rejects a mise or uv hold without an expiry (rung 2).
- **Version order is injected** (`compare`) because it belongs to each updater: npm's semver `order` (`npm/core/internal/spec.ts`), mise's `compareVersions`, and uv's numeric order (a `compareReleases` built next to `isNewerRelease`). As a result `below` (range holds) now works for mise and uv too, at no extra cost.
- `npm/core/internal/policy.ts` keeps `GroupSchema` and `PolicySchema`. It imports `HoldSchema`, `utcDay`, `holdActive` and `latestUntil` from `updates/core`, and stops exporting them itself. The field `packages` is renamed to `names`. No `package.json` declares a hold today, so the rename touches no data. Only `npm/CLAUDE.md` and the tests change.
- `npm/core/internal/plan.ts` drops its local `heldBy` and calls the shared one with `order`. `coherence.ts` `policyProblems` calls `holdProblems` for the bound part.

### 2. The contract exposes holds as data

`Updater.holds` changes from `{ file }` to `{ file; read(root): Promise<readonly Hold[]> }`.

- npm: `read` returns the holds from every workspace policy (it already computes them, at `npm-updater.ts:80`).
- mise: `read` returns `HOLDS` from `toolchain/core`.
- uv: `read` returns `UV_HOLDS`.

The generic detect job (`updates/server/internal/detect-job.ts`) and the runner (`updates/cli/internal/runner.ts`) call `holdProblems(await u.holds.read(root), today, u.holds.file)` before detecting or planning. If any hold was set past its bound, they **fail loudly** and name the file (rung 4). This means a future updater gets the bound enforced without writing a check of its own. A static check cannot do it generically, because updaters are server contributions that only a backend boot collects.

### 3. Static checks (rung 3), one per updater, all using `holdProblems`

- npm: `deps-npm:policy`, unchanged in behaviour.
- mise: `toolchain:resolved` gains the bound (it already reads `HOLDS`). It runs `holdProblems(HOLDS, utcDay(new Date()), "plugins/toolchain/core/internal/tools.ts")`.
- uv: a new `uv-updater/check/index.ts` → `deps-uv:holds` that runs `holdProblems(UV_HOLDS, …)`. For the check to import `UV_HOLDS`, the constant moves from `server/internal/uv-updater.ts` into a new `uv-updater/core/` barrel (`holds.ts`), and the server imports it from there.

### 4. Expired holds are inert, held rows are visible (mise and uv now behave like npm)

- `toolchain/core/internal/versions.ts`:
  - `upgradeTarget(tool, available, today)` skips only releases under an **active** hold.
  - `lockProblems(…, { today })` fails on a locked release only while an active hold covers it. Once the hold expires, landing that release is legitimate.
  - Both use `heldBy(HOLDS, tool, v, today, compareVersions)`.
- `mise-updater.ts` `detect`: a tool whose latest release is held is no longer filtered out. It is emitted with `waiting: heldWaiting(hold)`. The `plan` path that calls `upgradeTarget` passes `utcDay(new Date())`.
- `uv-updater.ts`:
  - `isHeld` becomes `heldBy(UV_HOLDS, pkg, v, today, compareReleases)`.
  - In `detect`, a held package move or CPython move is emitted with `waiting`, not skipped.
  - `newestCpython` keeps skipping held CPython releases, but it also returns the held newer release (if any), so that detect can report it.
  - `plan` already filters to actionable rows (check this during implementation; if it does not, filter with `isActionable`).
- The current CPython 3.15.0 hold gets `until: "2026-11-15"`: torch 2.15 is due 2026-10-28, plus slack. It stays well inside the 90-day bound.

### 5. Text

- `upgrade-prompt.ts` step 3 / the HELD paragraph: "a hold you add or renew carries a reason, an issue URL when upstream, and an `until` at most 90 days out, in that updater's holds file". The npm-only parenthetical is dropped, since the rule now applies to every updater.
- Doc comments on `HOLDS` / `UV_HOLDS` describe the shared model.
- Update `npm/CLAUDE.md` for the `names` field.
- §B of the 2026-10-16 doc gets one line: superseded for single-release holds by this doc.

## Critical files

- `plugins/infra/plugins/deps/plugins/updates/core/internal/{hold.ts (new), updater.ts, upgrade-prompt.ts}`, `updates/core/index.ts`
- `plugins/infra/plugins/deps/plugins/updates/{server/internal/detect-job.ts, cli/internal/runner.ts}`
- `plugins/infra/plugins/deps/plugins/npm/core/internal/{policy.ts, plan.ts, coherence.ts}`, `npm/core/index.ts`, `npm/server/internal/npm-updater.ts`
- `plugins/toolchain/core/internal/{tools.ts, versions.ts}`, `toolchain/check/index.ts`, `toolchain/core/index.ts`
- `plugins/infra/plugins/deps/plugins/mise/core/internal/mise-updater.ts`
- `plugins/infra/plugins/deps/plugins/python/plugins/uv-updater/{core/ (new), check/ (new), server/internal/uv-updater.ts}`

Boundary check: `toolchain/core` → `updates/core` and `uv-updater/check` → `uv-updater/core` are both allowed `core`/`check` edges. `updates/core` imports neither of them, so no import cycle is created.

## Verification

- Unit tests (`./singularity test` on `updates`, `npm`, `toolchain`, `uv-updater`):
  - `hold.ts`: `heldBy` with `version` and with `below` under an injected order; inert on the day after `until`; `holdProblems` at exactly +90 and at +91 days.
  - `versions.test.ts`: `upgradeTarget` and `lockProblems` with an active hold and with an expired one.
  - `uv-updater.test.ts`: `newestCpython` and the held CPython row.
  - The existing npm `plan` and `coherence` tests, after the `names` rename.
  - The runner test: an updater whose `holds.read` returns an out-of-bound hold aborts with the file named.
- `./singularity check toolchain:resolved deps-npm:policy deps-uv:holds`, then the full `./singularity build`.
- Temporarily set a hold's `until` to 120 days out in `tools.ts`, confirm `toolchain:resolved` fails with the message, then revert.
- Run `./singularity deps upgrade uv --only <x>` in the worktree: confirm the cpython 3.15.0 row shows as HELD until 2026-11-15 and is not moved.
