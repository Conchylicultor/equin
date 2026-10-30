# npm

The `npm` updater of `infra/deps`, and the dependency policy it enforces.
Design: `research/2026-10-16-global-deps-versions-always-move.md`, upstream of
self-published wrappers: `research/2026-10-17-global-deps-npm-upstream-of-wrappers.md`,
self-publishing wrappers and the `awaiting` arm:
`research/2026-10-28-global-deps-wrappers-auto-publish.md`.

## The model: nothing is pinned, everything moves

- **A spec is a range** (`^x.y.z` / `~x.y.z`, or `workspace:*`). `bun.lock` is
  what fixes a version; this updater is what moves the lock. An exact spec, a
  dist-tag (`latest`) or an open range fails `deps-npm:ranges` — an exact pin
  only ever said "never move", and that may not be said silently.
- **The updater** (`server/`, contributed to `UpdaterDeclare`) reads every
  workspace `package.json` + `bun.lock`, fetches each directly declared
  package's packument from registry.npmjs.org, and moves each to the newest
  release that is ≤ `dist-tags.latest`, published at least **3 days** ago
  (`NPM_COOLDOWN_DAYS`, as uv), not a prerelease unless the package's own
  `latest` is one, and not held. A new major rewrites the range (`^6.3.2` →
  `^7.1.0`). It runs through the generic runner (baseline/candidate gates,
  put-back on regression) like `mise` and `uv`.
- **Apply is two installs**: the spec is first written as the exact target
  (bun resolves exactly it), then widened back to the range (bun keeps a locked
  version its spec still satisfies). One install of `^to` would take whatever
  is newest at that moment. The lock is then verified to hold `to` in every
  declaring workspace, and `./equin regen-generated` runs so generated
  files derived through a moved package (prettier) match.
- **`sync`** (after the runner puts the files back) is `bun install` +
  `regen-generated` again, so `node_modules` and the generated files leave the
  candidate releases too. A group's moves share a `unit` (its first member), so
  the runner's narrowing never splits a group.
- Only **direct** dependencies are planned; a transitive one moves when its
  parent's new release asks for it.

## `dependencyPolicy` — shaping and waiting, never freezing

Declared in the `package.json` that owns the dependency, next to it:

```jsonc
"dependencyPolicy": {
  "groups": [{
    "id": "postgres-release",
    "members": ["@equin/pg-client-darwin-arm64", "…", "@embedded-postgres/darwin-arm64", "…"],
    "agree": "major.minor",            // "version" | "major.minor" | "major"
    "reason": "pg_dump must come from the server's Postgres release",
    "prerequisite": "the daily auto-publish … has not published it: check its run, fix, re-run",  // optional
    "wraps": {                         // optional: a group of wrappers WE publish
      "name": "PostgreSQL",
      "tags": { "repo": "https://github.com/postgres/postgres", "pattern": "^REL_(\\d+)_(\\d+)$" },
      "agree": "major.minor",          // which part of a wrapper version names the upstream release
      "after": "embedded-postgres",    // optional: a group that must publish the release first
      "prerequisite": "the daily auto-publish … has not published PostgreSQL <version> …"
    }
  }],
  "ownScopes": ["@equin"],             // root package.json only: the scopes we publish
  "holds": [{
    "names": ["react"],
    "below": "20.0.0",                 // or "version": "19.2.1" (one broken release)
    "reason": "…",
    "issue": "https://…",              // optional
    "reviewBy": "2027-01-10"           // ≤ 90 days from the day it is set or renewed
  }]
}
```

- **Lockstep group** — members move as ONE move, to the newest versions on
  which every group they share agrees. They never stop moving. A member whose
  newest release its partners cannot follow yet is never dropped: when they
  have published it and are only inside the cooldown, it is **WAITING**
  (`awaiting` `{ kind: "cooldown", of, until }`: `until` is the last cooling
  partner's publish plus the cooldown); when one has not, it is **BLOCKED** with
  the group's `prerequisite` (the weekly task asks for it), or, for a group
  without one (Zonky has not published one platform yet), **WAITING** on the
  lagging partners (`{ kind: "publish", by, release, since }`, `since` = when
  the leading member published it). A WAITING row rides along in the task text
  but never files one — until a publish wait passes `AWAIT_MAX_DAYS` (30,
  `updates/core`), when the detection reports it BLOCKED: add a hold (which
  makes the row HELD), chase upstream, or replace the dependency.
  `deps-npm:groups-coherent` asserts the lock holds one copy per member and the
  members agree. Today: `typescript-eslint` (root), `embedded-postgres`,
  `pg-client` + `postgres-release` (`database/client-tools`), `pgbouncer`.
- **Hold** — releases not to land, until a diff deletes the hold. Its
  `reviewBy` is at most 90 days out (`deps-npm:policy` rejects one further).
  Past it the hold is **lapsed**: still honoured, but the automation files an
  upgrade task listing it under "Holds to review", and `deps upgrade` refuses to
  run (verdict `holds-to-review`) until it is lifted (deleted) or renewed (a new
  `reviewBy` and a reason saying what was checked) — the shared model of
  `infra/deps/updates`. The held release is always listed (**HELD**) in every
  upgrade task; held rows alone never file one.
- **Wrappers we publish** (`wraps`) — the registry cannot show an upstream
  release nobody has wrapped, because we are who would wrap it. `detect` reads
  the upstream's release tags (`git ls-remote`, `newestTag`) and, when the
  newest is ahead of every release any member has published (on `wraps.agree`),
  reports one row `<name> (upstream of group …)` — `upstreamRows`. It is
  **BLOCKED** with `wraps.prerequisite` (`<version>` filled in): the wrappers
  publish themselves (a daily CI run in their repo), so a release still
  unwrapped a detection later means that run failed or GitHub disabled it.
  With `wraps.after` (a group id, held by `deps-npm:policy`) the wrapper is
  built from that group's release: while no member of it has published the
  upstream release either, the row is **WAITING** on them (`since` = the
  upstream tag's date: the newest tag alone is fetched, depth 1 and no trees, into
  a throwaway bare repo — the tagger date of an annotated tag, the commit date of
  a lightweight one like PostgreSQL's); once one has, there
  is no upstream row — the lockstep group spanning both reports the lag from
  the registry. Once a wrapper is published (cooldown or not), the registry
  side takes over. A hold naming a member of the wrapper group and covering the
  upstream release makes the row HELD. A tag pattern matching nothing throws.
  `deps-npm:wrappers-declared` makes every dependency in a root `ownScopes`
  scope belong to a group with `wraps`. Today: `pgbouncer` (PgBouncer,
  `version` — the wrapper's version is PgBouncer's own) and `pg-client`
  (PostgreSQL, `after` `embedded-postgres`: its CI smoke test needs the
  matching server).
- **Patched packages** (`patchedDependencies`) are BLOCKED on porting the
  patch: it names the exact version it applies to.

Why every newer release ends up moved, held (reviewed at least every 90 days — lifted or renewed),
blocked (asked for every cycle) or awaiting (listed every cycle, until someone else publishes — at most 30 days
for a publish, then blocked): there is no
other arm in `planNpm`, no spec can opt out (`deps-npm:ranges`), and a release only an upstream of ours has
made is seen through `wraps` (`deps-npm:wrappers-declared`).

## Checks

`deps-npm:ranges`, `deps-npm:policy`, `deps-npm:groups-coherent`,
`deps-npm:wrappers-declared` — pure
functions in `core/internal/coherence.ts` over `readWorkspace(root)`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The `npm` updater: moves every npm package a workspace package.json declares (its range and bun.lock) to the newest release past a 3-day cooldown, lockstep groups together, honouring reviewed holds — contributed to the infra/deps updater registry.
- Server:
  - Contributes: `updater` "npm"
  - Uses: `infra/deps/updates.UpdaterDeclare`
- Core:
  - Uses:
    - `infra/deps/updates.heldBy`
    - `infra/deps/updates.heldWaiting`
    - `infra/deps/updates.Hold`
    - `infra/deps/updates.holdProblems`
    - `infra/deps/updates.HoldSchema`
    - `infra/deps/updates.Move`
    - `infra/deps/updates.Outdated`
    - `infra/deps/updates.OutdatedWaiting`
    - `infra/deps/updates.utcDay`
    - `infra/spawn.spawnCaptured`
    - `packages/semaphore.createSemaphore`
  - Exports (types):
    - `Packument`
    - `Plan`
    - `Workspace`
  - Exports (values):
    - `groupProblems`
    - `installedVersions`
    - `newestTag`
    - `planNpm`
    - `policyProblems`
    - `rangeAt`
    - `readWorkspace`
    - `unrangedSpecs`
    - `upstreamRows`
    - `workspaceManifests`
    - `wrappersUndeclared`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `core/internal/workspace.ts`, `server/internal/npm-updater.ts` (debt)

<!-- AUTOGENERATED:END -->
