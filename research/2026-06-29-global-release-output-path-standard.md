# Standard release output path — discoverable agent releases

**Date:** 2026-06-29
**Category:** global (cli + release plugin + launcher)
**Status:** Plan — awaiting approval

## Context

An agent (this session) was asked to "release sonata on tauri" and ran
`./equin release --composition sonata --target tauri` by hand. It worked,
but exposed three gaps that make agent-run releases **undiscoverable**:

1. **Two divergent path conventions.** The CLI default `--out` is
   `dist/release/<comp>-<target>-<timestamp>/` (timestamped, in-repo). The Studio
   engine (`run-release.ts`) overrides it with `releaseOutDir()` →
   `~/.singularity/releases/<worktree>/<comp>-<target>/` (stable, overwrites in
   place). A hand-run release and an engine-run release land in different places.
2. **The shippable artifact escapes `--out`.** For `--target tauri` the final
   `.app`/`.dmg` are emitted by cargo into
   `tauri/src-tauri/target/release/bundle/{macos,dmg}/` — **not** under `--out`.
   For `--target web` the packed self-extracting binary lands at
   `dirname(<out>)/<comp>-<target>-<platform>` — a *sibling* of `<out>`, not
   inside it. So even pointing someone at `<out>` doesn't give them the product.
3. **No stable, documented place to look.** Nothing tells an agent where releases
   live; the location depends on which code path produced them.

**Decision (from the user):** standalone CLI releases are **deliberately NOT
recorded in the `release_runs` DB table.** Discoverability is achieved through a
**single canonical filesystem path + a `latest` symlink + a self-describing
`RELEASE.json`** — not a registry query. This keeps the CLI cleanly DB-free.

**Intended outcome:** every release (hand-run or engine-driven) lands at one
predictable, versioned, self-contained location:

```
~/.singularity/releases/<worktree>/<comp>-<target>/<run-id>/   ← contains RELEASE.json + the shippable bundle
~/.singularity/releases/<worktree>/<comp>-<target>/latest → <run-id>   (symlink, stable pointer)
```

`<run-id>` (`release-<ms>-<rand>`) embeds a timestamp, so chronology is in the
path; the `latest` symlink is the stable "current build" pointer. Releases are
**kept** (no overwrite-in-place); retention/sweep is a deferred follow-up.

## Key facts established during exploration

- **The 104-byte Unix-socket cap does NOT actually constrain the artifact path.**
  - Preview (`preview-manager.ts`) spawns `<artifactPath>/launch` with
    `SINGULARITY_DIR=/tmp/sgp-XXXXXX` (a fresh short mkdtemp), so preview sockets
    never live under the artifact path.
  - The packed web binary and the tauri `.app`/`.dmg` self-extract to their own
    short data roots, unrelated to `<out>`.
  - The **only** flow where `<out>` length matters is running `<out>/launch`
    *directly*: `launch.ts:27` sets `SINGULARITY_DIR ??= <out>/data`, and PG opens
    `<out>/data/postgres/socket/.s.PGSQL.5433`. `launch.ts` does **not** set
    `SINGULARITY_PG_SOCKET_DIR` today.
  - Both PG (`database/embedded/shared/internal/paths.ts:36`) and PgBouncer
    (`database/pgbouncer/shared/internal/paths.ts:12`) read the single env
    override `SINGULARITY_PG_SOCKET_DIR`. Setting it to a short `/tmp` dir in
    `launch.ts` removes path length as a constraint entirely → a versioned
    `<run-id>` segment becomes safe even for direct launch.
- **The CLI writes nothing to the DB**; only the engine does. The engine always
  passes `--dev` (so for tauri it runs `tauri dev`, never producing `.app`/`.dmg`)
  — the shippable-artifact path is exclusively the hand-run CLI.
- **`releaseOutDir` lives in `release/server/internal/out-dir.ts`** and is used by
  the engine. Importing the `@plugins/release/server` barrel only *builds*
  descriptor objects at import; the `db` pool is lazy (connects on first query),
  so the CLI can import shared helpers from that barrel without an import-time DB
  connection (verify during implementation; fallback below).
- **Engine changes are non-breaking:** the engine always `--dev`, so it never
  reaches `packStagedTree`/the tauri-build branch — the artifact-placement changes
  affect **standalone CLI only**. The path/symlink/run-id changes affect both, and
  preview still spawns `<artifactPath>/launch` correctly from the versioned dir.

## Plan

### 1. Version + unify the path — `release/server/internal/out-dir.ts`
- Add `newReleaseRunId()` → `` `release-${Date.now()}-${rand}` `` (lift the exact
  format currently inlined in `run-release.ts:158`).
- Change `releaseOutDir(composition, target, runId)` to append the `<runId>`
  segment: `join(SINGULARITY_DIR, "releases", currentWorktreeName(),
  \`${composition}-${target}\`, runId)`.
- Rewrite the docstring: the path is now **versioned** (not overwrite-in-place);
  the length constraint is lifted by the `launch.ts` socket-dir decoupling (§4);
  `<run-id>` provides chronology + a stable dir key.

### 2. Export the helpers — `release/server/index.ts`
- `export { releaseOutDir, newReleaseRunId } from "./internal/out-dir";`
- **Verify** importing `@plugins/release/server` from the CLI does not eagerly
  connect to PG. *Fallback if it does:* the CLI builds the path inline from
  `@plugins/infra/plugins/paths/server` (`SINGULARITY_DIR`,
  `currentWorktreeName`) + a shared run-id constant, with `out-dir.ts` annotated
  as the canonical twin.

### 3. Update the engine call site — `release/server/internal/run-release.ts`
- Pass the existing `releaseId` into `releaseOutDir(composition, target,
  releaseId)` (line ~159). `artifactPath` is still set to `out` (now the versioned
  dir) — no other engine change; preview/reconcile keep working.

### 4. Lift the length constraint — `infra/plugins/launcher/bin/launch.ts`
- Before the dynamic `import(...)` (after the other `??=` env lines), add:
  `process.env.SINGULARITY_PG_SOCKET_DIR ??= mkdtempSync(join("/tmp", "sgs-"));`
  so PG/PgBouncer sockets are always on a short path regardless of `<out>` length.
- Add optional `runId?: string` to the local `ReleaseManifest` interface (§5
  writes it; launch doesn't need to act on it).
- *Minor:* preview leaves an empty `/tmp/sgs-*` socket dir behind on stop (its
  teardown only removes the `/tmp/sgp-*` data root). Negligible (empty dir); note
  as a cleanup follow-up, do not block.

### 5. Make `<out>` self-contained — `framework/plugins/cli/bin/commands/release.ts`
- **Default `--out`:** replace `dist/release/<comp>-<target>-<timestamp>` with
  `releaseOutDir(opts.composition, opts.target, newReleaseRunId())` (imported per
  §2). Derive `const runId = basename(out)` so engine-supplied and CLI-default
  `--out` are handled uniformly.
- **RELEASE.json:** add `runId` to the manifest object (line ~465-476).
- **`latest` symlink:** after staging (once, all targets/modes), refresh
  `dirname(out)/latest` → `runId` (`rmSync(force)` then `symlinkSync`).
- **Web (`packStagedTree`):** write the self-extracting binary **inside** `<out>`
  — `<out>/dist/<comp>-<target>-<platform>` — instead of `dirname(stagedDir)`.
  Safe: the tar (`-C stagedDir .`) runs before the binary exists and the CLI
  rmSyncs `<out>` before staging. Update the `[done]` line.
- **Tauri (`wrapTauri`):** after `tauri build` (+ `packageMacDmg`), `cpSync` the
  `.app` and `.dmg` into `<out>/bundle/`. Update the `[done]` lines to print the
  `<out>/bundle/...` paths. Non-darwin: copy the produced `bundle/` tree into
  `<out>/bundle/`. (`wrapTauri` already receives `stagedDir = out`.)
- Update the top-of-file staged-layout comment to show `dist/` (web) and
  `bundle/` (tauri) plus `RELEASE.json.runId`.

### 6. Document discovery — `plugins/release/CLAUDE.md`
- Replace the "Short out-dir" bullet: artifacts are versioned at
  `~/.singularity/releases/<worktree>/<comp>-<target>/<run-id>/` with a `latest`
  symlink; length is safe via the `launch.ts` socket decoupling.
- Add a **"Discovery"** section: the canonical path **is** the registry for
  agent/CLI releases — list `~/.singularity/releases/<worktree>/`, follow
  `latest`, read `RELEASE.json` (self-describing: composition, target, platform,
  builtAt, port, runId); `<run-id>/` contains the shippable bundle
  (`bundle/*.app|*.dmg` or `dist/<...>`). State explicitly that **standalone CLI
  releases are not recorded in `release_runs`** (that table is the Studio engine's
  dev/preview history only).

## Files to modify

- `plugins/release/server/internal/out-dir.ts` — runId param + `newReleaseRunId()` + docstring
- `plugins/release/server/index.ts` — re-export helpers
- `plugins/release/server/internal/run-release.ts` — pass `releaseId` to `releaseOutDir`
- `plugins/infra/plugins/launcher/bin/launch.ts` — short PG socket dir + `runId` in manifest type
- `plugins/framework/plugins/cli/bin/commands/release.ts` — default out, RELEASE.json.runId, `latest` symlink, web binary into `<out>/dist/`, tauri bundle into `<out>/bundle/`, layout comment
- `plugins/release/CLAUDE.md` — Short-out-dir bullet rewrite + Discovery section

## Verification

1. `./equin build` (regenerates nothing schema-wise; ensures it compiles +
   `./equin check` passes — boundaries/type-check).
2. **Tauri (the original ask):**
   `./equin release --composition sonata --target tauri`
   - Assert `~/.singularity/releases/<wt>/sonata-tauri/<run-id>/bundle/Sonata.app`
     and `Sonata.dmg` exist.
   - Assert `~/.singularity/releases/<wt>/sonata-tauri/latest` resolves to
     `<run-id>` (`readlink`).
   - Assert `<run-id>/RELEASE.json` contains `runId`, `composition: "sonata"`,
     `target: "tauri"`.
3. **Web:** `./equin release --composition sonata --target web`
   - Assert the binary is at `<out>/dist/sonata-web-<platform>` and runs:
     execute it, confirm `http://sonata.localhost:9100` serves, and confirm (via
     the launch log `Root:` line / `lsof`) the PG socket is under `/tmp/sgs-*`,
     not under `<out>/data` (socket decoupling works for a long path).
4. **Studio preview unaffected:** trigger a release from the Studio Release pane
   (engine path, `--dev`), open the preview — confirm it still starts (engine sets
   `artifactPath` to the new versioned dir and `preview-manager` spawns
   `<artifactPath>/launch` with the `/tmp/sgp-*` data root).
5. **Discovery doc check:** `./equin check` (plugins-doc-in-sync) passes
   after the CLAUDE.md edits.

## Out of scope / follow-ups

- **Retention sweep** (keep last N per `<comp>-<target>`, delete older `<run-id>`
  dirs). Kept-all + `latest` now; sweep is a separate task — file via `add_task`.
- **Recording standalone releases in `release_runs`** — explicitly declined.
- **Engine producing real (non-dev) tauri artifacts** — pre-existing limitation,
  unrelated to this change.
- **Cleaning the leaked empty `/tmp/sgs-*` preview socket dir** — minor.
