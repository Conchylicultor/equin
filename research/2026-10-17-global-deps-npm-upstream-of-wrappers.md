# Self-published wrappers learn about new upstream releases

Status: **implemented 2026-10-17.** PgBouncer compares `major.minor`, not `version`: `@equin/pgbouncer` 1.25.7 has no upstream 1.25.7 (the wrapper numbers its own patches). First live detect: PostgreSQL 18.6 and PgBouncer 1.26.1 reported BLOCKED.

## Context

`research/2026-10-16-global-deps-versions-always-move.md` promises that every
pinned version eventually moves: it is moved, held (≤ 90 days), or BLOCKED (asked
for in every weekly upgrade task). The npm updater
(`plugins/infra/plugins/deps/plugins/npm`) only sees what is on registry.npmjs.org.
Two package families are wrappers **we** build and publish from upstream sources:

| Family | Wrapper repo | Upstream | Today |
|---|---|---|---|
| `@equin/pgbouncer-*` ×4 (group `pgbouncer`, `database/pgbouncer/package.json`) | `equinai/pgbouncer-embedded` | PgBouncer (`pgbouncer/pgbouncer`, tags `pgbouncer_1_25_1`) | **never noticed**: no group member ever publishes ahead of us |
| `@equin/pg-client-*` ×4 (groups `pg-client`, `postgres-release`, `database/client-tools/package.json`) | `equinai/pg-client-embedded` | PostgreSQL (`postgres/postgres`, tags `REL_18_4`) | noticed **only** once the third-party `@embedded-postgres/*` publishes the release (then `postgres-release` reports BLOCKED) |

So a new PgBouncer is invisible forever, and a new Postgres is invisible until
someone else wraps it. Nothing in `planNpm` (`npm/core/internal/plan.ts`) can see
it: every row is derived from packuments.

Outcome wanted: a new upstream release that no wrapper has published yet shows
up as a **BLOCKED** row in the upgrade task (actionable, so it files the task),
whose prerequisite is "publish the wrapper for it".

## Design

### 1. A group declares what it wraps (`dependencyPolicy`, data)

Extend `GroupSchema` (`npm/core/internal/policy.ts`) with an optional `wraps`:

```jsonc
// database/pgbouncer/package.json
{
  "id": "pgbouncer",
  "members": ["@equin/pgbouncer-darwin-arm64", "…"],
  "agree": "version",
  "reason": "one PgBouncer build per platform",
  "wraps": {
    "name": "PgBouncer",
    "tags": {
      "repo": "https://github.com/pgbouncer/pgbouncer",
      "pattern": "^pgbouncer_(\\d+)_(\\d+)_(\\d+)$"
    },
    "agree": "major.minor",
    "prerequisite": "publish @equin/pgbouncer-* <version> from github.com/equinai/pgbouncer-embedded (bump the PgBouncer version in scripts/build.sh, tag v<version>), then upgrade"
  }
}
```

```jsonc
// database/client-tools/package.json — on the `pg-client` group
"wraps": {
  "name": "PostgreSQL",
  "tags": { "repo": "https://github.com/postgres/postgres", "pattern": "^REL_(\\d+)_(\\d+)$" },
  "agree": "major.minor",
  "prerequisite": "<the existing postgres-release prerequisite text>"
}
```

- `tags.pattern`: 1–3 capture groups → `major[.minor[.patch]]`, missing parts `0`.
  Upstream prereleases (`REL_19_BETA1`, `REL_19_RC1`) don't match by construction.
- `agree` (reuses `AGREE`): which part of the wrapper version names the upstream
  release (`18.3.0` ↔ PG `18.3` is `major.minor`).
- `prerequisite` may contain `<version>`, substituted with the upstream version.
- One source kind (`tags`, read with `git ls-remote`) — a closed list; a second
  kind becomes a discriminated union arm when needed. `git ls-remote --tags --refs`
  needs no auth and no API rate limit, and works for both upstreams.
- `deps-npm:policy` (already Zod-validates the policy) additionally rejects a
  `pattern` that does not compile or has 0 / >3 capture groups.

### 2. Pure decision: `upstreamRows` (core, next to `planNpm`)

New `npm/core/internal/upstream.ts`, exported from the core barrel:

```ts
upstreamRows({ groups, packuments, upstream: Map<groupId, string[] /* versions */> }): Outdated[]
```

For each group with `wraps`:

- `newestUpstream` = highest version from the tags (`Bun.semver.order`).
- `newestWrapped` = highest **published** release (packument, cutoff ignored) of
  any member, reduced to `wraps.agree`.
- If `key(newestUpstream) > key(newestWrapped)` → one row
  `{ name: "PgBouncer (upstream of `pgbouncer`)", current: <group's newest
  published>, latest: newestUpstream, waiting: { kind: "blocked", prerequisite } }`.
- Otherwise nothing: once any wrapper release exists for it, the existing
  machinery (move, or BLOCKED by a lagging partner) already reports it — so no
  duplicate rows. Comparing against *published* (not installed) is what keeps a
  published-but-cooling-down wrapper from re-asking for a publish.

No cooldown on the upstream side: the row asks for a publish, not an adoption;
the wrapper's own npm release then passes the normal 3-day cooldown.

### 3. Wiring (server)

`npm-updater.ts` `planNow`: for each group with `wraps`, fetch tags (new
`fetchTags(repo, pattern)` via `spawnCaptured(["git","ls-remote","--tags","--refs",repo])`,
throwing on a non-zero exit — fail loudly like `fetchPackument`), then
`detect` returns `[...plan.outdated, ...upstreamRows(...)]`. `plan`/`apply` are
unchanged: an upstream row has no move. Fetch only in `detect` (it is the only
consumer), so `deps upgrade` stays as fast as today.

Rendering needs nothing new: `formatOutdated` (`updates/core/internal/upgrade-prompt.ts`)
already prints `— BLOCKED, do this first: …`, and `isActionable` makes the row
file the weekly task.

### 4. Make "a wrapper with no `wraps`" impossible to forget (check)

The guarantee only holds if every self-published family declares its upstream.
Add `ownScopes: ["@equin"]` to the **root** `package.json`'s `dependencyPolicy`
(a new optional `PolicySchema` key, allowed only at the root), and a check
`deps-npm:wrappers-declared`: every declared dependency in an owned scope belongs
to a group that has `wraps`. Pure function in `coherence.ts` beside the other
checks, registered in `npm/check/index.ts`. Removing `wraps` from pgbouncer then
fails `./singularity check`.

### 5. Docs

- `npm/CLAUDE.md`: document `wraps` and `ownScopes` in the `dependencyPolicy`
  block; add the fourth source of rows to "why every newer release ends up …".
- `database/pgbouncer/CLAUDE.md`, `database/client-tools/CLAUDE.md`: replace
  "noticed when @embedded-postgres publishes" with the upstream detection.
- Add a superseded-note pointer in the 2026-10-16 doc, case 4.

## Known limit (unchanged, stated)

If Postgres ships 18.4 and we publish `@equin/pg-client` 18.4 before the
third-party `@embedded-postgres` does, `postgres-release` then waits on them
(BLOCKED without our prerequisite). That is waiting on a third party, still
listed every cycle — not silent. (pg-client's CI smoke test runs against the
matching `@embedded-postgres`, so in practice the publish itself may have to wait;
the row keeps asking until then.)

## Files

- `plugins/infra/plugins/deps/plugins/npm/core/internal/policy.ts` — `wraps`, `ownScopes`
- `plugins/infra/plugins/deps/plugins/npm/core/internal/upstream.ts` (+ `upstream.test.ts`) — new
- `plugins/infra/plugins/deps/plugins/npm/core/internal/coherence.ts` (+ test) — pattern validation, `wrappersUndeclared`
- `plugins/infra/plugins/deps/plugins/npm/core/index.ts`, `check/index.ts`
- `plugins/infra/plugins/deps/plugins/npm/server/internal/npm-updater.ts` — `fetchTags`, `detect`
- `plugins/database/plugins/pgbouncer/package.json`, `plugins/database/plugins/client-tools/package.json`, root `package.json`
- CLAUDE.md files above

## Verification

- `./singularity test plugins/infra/plugins/deps/plugins/npm`: `upstreamRows` —
  upstream ahead → one BLOCKED row with `<version>` substituted; a wrapper
  release exists (even cooling down) → no row; `major.minor` mapping
  (PG `18.4` vs `18.3.0`); pattern capture padding; check fails for an `@equin`
  dep in a group without `wraps`.
- `./singularity check deps-npm:policy deps-npm:wrappers-declared` green; drop
  `wraps` from pgbouncer in a scratch edit → fails.
- Live: a small `./singularity run` script (or `deps detect` if the CLI exposes
  it) calling `npmUpdater.detect(root)` in this worktree — confirm the real
  PgBouncer / Postgres tags parse and rows appear exactly when upstream is ahead
  of the published wrappers.
