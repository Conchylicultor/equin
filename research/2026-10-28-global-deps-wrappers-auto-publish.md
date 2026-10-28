# Self-published wrappers publish themselves; third-party waits stop filing tasks

Status: **plan**, 2026-10-28.

## Context

`research/2026-10-17-global-deps-npm-upstream-of-wrappers.md` made the npm updater
*see* new upstream releases of our two wrapper families (`@equin/pg-client-*`,
`@equin/pgbouncer-*`) and report them BLOCKED with "publish the wrapper". But the
publish is manual, in another repo, and no agent session can do it — so the
weekly Dependency upgrades task asks for work nobody can do from it. Today:
`@embedded-postgres/*` is at `18.4.0-beta.17`, `@equin/pg-client` has only ever
published `18.3.0`, so both families sit at 18.3; PgBouncer is at 1.26.x
upstream while `@equin/pgbouncer` wraps 1.25.2 (published as 1.25.7).

Two more defects in the same rows:

- A PostgreSQL tag that `@embedded-postgres` has not published yet is reported
  BLOCKED "publish pg-client" — impossible: the client's CI smoke test needs the
  matching server package.
- A lockstep group with no `prerequisite` whose partner lags (Zonky has not
  published one platform yet) is BLOCKED "wait for the lagging members" — and
  BLOCKED is actionable, so it files a task whose only instruction is to wait.
  Same for a partner that *has* published but is inside the 3-day cooldown.

Outcome: a new upstream release lands with no human step (wrapper CI builds,
smoke-tests and publishes it; the updater moves it like any npm release). A row
that only waits on someone else rides along in the task text but never files
one. BLOCKED means "there is work for the agent" again — for a wrapper, that the
auto-publish failed.

## Design

### 1. `pg-client-embedded`: publish on every new `@embedded-postgres` release

- **One source of truth.** `scripts/build.sh` reads `PG_VERSION` from the
  environment (required, no default). The workflow derives it from
  `EMBEDDED_POSTGRES_VERSION` (`18.4.0-beta.17` → `18.4`), so the two can no
  longer disagree. The hardcoded `EMBEDDED_POSTGRES_VERSION` env becomes a
  `resolve` job output.
- **`resolve` job** (first job; `build` needs it):
  - `schedule` (daily cron) / `push` / `pull_request`: server =
    `npm view @embedded-postgres/linux-x64 version` (its `latest`); version =
    `<major>.<minor>.0`.
  - `workflow_dispatch` / tag push: version from the input / tag as today; the
    server = the newest `@embedded-postgres/linux-x64` release with that
    `major.minor` (fail if none).
  - `publish=true` only if the trigger is schedule / dispatch / tag **and**
    `npm view @equin/pg-client-linux-x64@<version> version` is empty (a re-run
    or an already-published release is a no-op success). `build` is skipped on a
    schedule run with nothing to publish.
- **`publish` job** gated on `needs.resolve.outputs.publish == 'true'`, then
  `contents: write` to push tag `v<version>` (traceability; a `GITHUB_TOKEN`
  push does not re-trigger the workflow, and the published-check makes it
  harmless anyway).
- README: the release procedure becomes "nothing; or dispatch with a version".

### 2. `pgbouncer-embedded`: publish on every new PgBouncer tag

- **Wrapper version = upstream version** from now on (1.26.1 wraps PgBouncer
  1.26.1; 1.26.1 > 1.25.7, so the switch is monotonic). The wrapper's own patch
  numbering (1.25.2 → 1.25.7) cannot coexist with auto-detection: it would hide
  upstream patch releases. A wrapper-only rebuild rides the next upstream
  release (documented in the README).
- `scripts/build.sh` reads `PGBOUNCER_VERSION` from the environment and derives
  the tarball URL (`pgbouncer_<X_Y_Z>/pgbouncer-<X.Y.Z>.tar.gz`).
- Same `resolve` → `build` → `publish` shape as §1: upstream =
  highest `refs/tags/pgbouncer_(\d+)_(\d+)_(\d+)` from
  `git ls-remote --tags --refs https://github.com/pgbouncer/pgbouncer`;
  published-check on `@equin/pgbouncer-linux-x64@<version>`; add
  `pull_request` + `schedule` triggers (PR = build + verify, no publish).

Scheduled workflows on a public repo are disabled after 60 days without
activity; the equin side (§3) is the backstop — a wrapper still behind a week
later is BLOCKED with "check the auto-publish (and `gh workflow enable`)".

### 3. equin: a third arm of `OutdatedWaiting` — `awaiting`

`plugins/infra/plugins/deps/plugins/updates/core/internal/updater.ts`:

```ts
export type OutdatedWaiting =
  | { kind: "held"; … }
  | { kind: "blocked"; prerequisite: string }
  /** Someone else must publish first; nothing for an upgrade task to do. */
  | { kind: "awaiting"; on: string }; // structured and bounded since — see §4

export function isActionable(o: Outdated): boolean {
  return o.waiting === undefined || o.waiting.kind === "blocked";
}
```

`formatOutdated` (`upgrade-prompt.ts`): `— WAITING on <on> (nothing to do)`.
tsc finds every other switch.

**`wraps.after`** (`npm/core/internal/policy.ts`, optional): the id of a group
that must publish an upstream release before the wrapper can be built from it.
`upstreamRows` (`upstream.ts`), for a release no wrapper has published:

- `after` set, and no member of that group has published it (on
  `wraps.agree`) → `awaiting`, `on: "<after group's members' scope> to publish
  PostgreSQL 18.6"`.
- `after` set and that group *has* published it → **no row**: the lockstep
  group (`postgres-release`) already reports the lag from the registry side.
- no `after` → BLOCKED with `prerequisite`, as today.

`deps-npm:policy` additionally rejects an `after` naming no declared group.

**Lagging-partner rows** (`plan.ts`, the `order(newestAllowed, to) > 0` branch):
compute, once per component, the assignment over every *published* release
(cutoff and holds ignored). For member `m`:

- that assignment reaches `newestAllowed` for `m` → the partners have published
  it and are cooling down → `awaiting`, `on: "the cooldown of <partners>"`;
- else the group has a `prerequisite` → BLOCKED with it (as today);
- else → `awaiting`, `on: "<lagging partners> to publish <version>"` (replacing
  the BLOCKED "wait for the lagging members").

**Data** (`package.json` policies):

- `database/client-tools`: `pg-client.wraps.after: "embedded-postgres"`. Both
  prerequisites become "the daily auto-publish of github.com/equinai/pg-client-embedded
  has not published it: check its latest Build and Publish run (re-enable the
  workflow if GitHub disabled it), fix and re-run".
- `database/pgbouncer`: `wraps.agree: "version"`; prerequisite rewritten the
  same way for pgbouncer-embedded.

**Docs**: `npm/CLAUDE.md` (`after`, `awaiting`, "every newer release ends up …"
now four outcomes), `updates/CLAUDE.md`, `database/client-tools/CLAUDE.md`,
`database/pgbouncer/CLAUDE.md` (no manual publish step), a superseded note in
the 2026-10-17 doc.

### 4. Deadline: a wait on someone else's publish is bounded

An `awaiting` row files no task, so a third party that never publishes would pin
us forever with nothing asking — the guarantee of
`2026-10-16-global-deps-versions-always-move.md` broken. So `on` is facts, not
prose (`updates/core`'s `AwaitingOn`):

```ts
type AwaitingOn =
  | { kind: "publish"; by: readonly string[]; release: string; since: string }
  | { kind: "cooldown"; of: readonly string[]; until: string };
```

- `since`: a lagging partner's wait starts when the leading member published the
  release (its packument time); a `wraps.after` wait at the upstream tag's date
  (fetched for the newest tag only). A cooldown's `until` is the last cooling
  partner's publish plus the updater's cooldown.
- `AWAIT_MAX_DAYS = 30` (beside `HOLD_MAX_DAYS`). `awaitingOrBlocked(on, now)`
  turns a publish wait older than that into BLOCKED: "waited <n> days (since
  <day>) for <by> to publish <release>: add a hold on it in this updater's holds
  file (…), chase upstream, or replace the dependency". A cooldown wait never
  escalates — it ends by construction.
- **Enforced centrally, by type.** Updaters never decide the escalation: they
  report facts. The detect job runs every row through `boundedRows(rows, now)`,
  and `OutdatedUpdater.outdated` is its branded `BoundedRows`, so the task's text
  (`outdatedSections`), title and `hasUpgradeWork` cannot be fed an unbounded
  wait — not by an updater skipping a helper, not by a consumer forgetting one.
- A hold silences the escalated row (it becomes HELD) — for a `wraps` row too: a
  hold naming a member of the wrapper group and covering the upstream release.
- `formatOutdated` is the one place the text is written: `— WAITING on
  @embedded-postgres to publish PostgreSQL 18.6 (since 2026-10-02; nothing to
  do)`, `— WAITING for the cooldown of @equin/pg-client-* (moves by itself after
  2026-10-31)`.

## Files

- `plugins/infra/plugins/deps/plugins/updates/core/internal/updater.ts`, `upgrade-prompt.ts` (+ tests)
- `plugins/infra/plugins/deps/plugins/npm/core/internal/{policy,upstream,plan,coherence}.ts` (+ tests)
- `plugins/database/plugins/{client-tools,pgbouncer}/package.json`, their `CLAUDE.md`
- `equinai/pg-client-embedded`: `.github/workflows/build-and-publish.yml`, `scripts/build.sh`, `README.md`
- `equinai/pgbouncer-embedded`: same three files

## Rollout

The wrapper changes are pushed straight to each repo's `main` (the user's
call). A push-to-main run exercises `resolve` + `build` (+ the pg-client smoke
test against 18.4) without publishing; the next daily scheduled run then
publishes pg-client 18.4.0 and pgbouncer 1.26.x. The equin side lands with
`./equin push` after review, as usual.

## Verification

- `./equin test plugins/infra/plugins/deps/plugins/npm plugins/infra/plugins/deps/plugins/updates`:
  - `upstreamRows`: `after` group lacks it → `awaiting`; has it → no row; no `after` → BLOCKED.
  - `planNpm`: partner published-but-cooling → `awaiting` (cooldown); unpublished, with prerequisite → BLOCKED; without → `awaiting`.
  - `isActionable` / `hasUpgradeWork`: an all-`awaiting` updater files nothing; `formatOutdated` text.
- `./equin check` (policy schema, `deps-npm:policy` rejects a bad `after`).
- Live: `./equin run` a script calling `npmUpdater.detect(root)` here — expect
  `PostgreSQL 18.6` (if `@embedded-postgres` lacks it) as WAITING, `postgres-release`
  18.4 as BLOCKED (pg-client not yet published), PgBouncer 1.26.x as BLOCKED.
- Wrapper PRs: green `resolve` + `build` (+ smoke test) runs; `publish` skipped.
