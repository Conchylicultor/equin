# F2 — `writeWorktreeSpec`: register a namespace from a static spec (no git)

> Status: implementation plan. F2 of the self-contained app-release vision
> ([`2026-06-19-global-self-contained-app-release.md`](./2026-06-19-global-self-contained-app-release.md), section F2 + "The run-profile model").
> Depends on F1 (composition build-gating) — **landed** (commit `407aa7fbf`).
> Category: `global` (touches `cli/build.ts` + `infra/worktree`).

## Context

A packaged app has no git worktree, but today a servable namespace is only ever
created by `./equin build` deriving its name from the git worktree root.
The runtime is already git-independent: the gateway derives
`SINGULARITY_WORKTREE=<spec-dir-basename>` (`gateway/worktree.go:584`, name from
`registry.go:315` `filepath.Base(filepath.Dir(p))`) and every identity consumer
reads that one env var (DB name `plugins/database/server/internal/client.ts:8`,
config dir, reports, profiling). `central` already proves a static, non-git
namespace registers fine through the same fsnotify watcher.

The goal of F2 is to **generalize that precedent into a reusable spec-writer** so
dev and release share one code path. The spec-writing tail of `build.ts` becomes
`writeWorktreeSpec({ name, server, web? })` in `infra/worktree/server`; the dev
build calls it for every spec it writes today, and the future release launcher
(F3) calls the same function with a fixed name and no git operation.

### Key facts established during exploration

- **The gateway's spec contract is pure identity**: `~/.singularity/worktrees/<name>/spec.json`
  with `{ server: <abs path>, web?: <abs path> }`. Dir basename = namespace =
  `SINGULARITY_WORKTREE`. `web` is optional — `central` writes `{ server }` only
  (`build.ts:766`, `:1066`). The gateway tolerates a missing `Web`
  (`gateway/worktree.go:60`).
- **Composition filtering is NOT in the spec.** F1's server selector branches on
  **file existence** of `server.composition.generated.ts`
  (`plugins/framework/plugins/server-core/bin/plugins-active.ts:12-14`), because
  "the gateway spawns this server (`bun bin/index.ts`) and cannot pass env." The
  web side is filtered at build time via the `vite.config.ts` alias on
  `VITE_COMPOSITION`. So filtering is baked into the *tree* the spec points at —
  the writer stays identity-only and knows nothing about compositions. This is
  the clean seam.
- **`build.ts` is the only `spec.json` writer**, with exactly three sites, all
  using `WORKTREES_DIR` (= `join(SINGULARITY_DIR, "worktrees")`):
  - `:766-771` central early write — `{ server: centralDir }`
  - `:1044-1054` main worktree spec — `{ server: <server-core>, web: livePath }`
  - `:1066-1072` central re-register (idempotency) — `{ server: centralDir }`
- **The worktree plugin already exposes `worktreesDir()`**
  (`plugins/infra/plugins/worktree/server/internal/worktree-op.ts:55`, same
  `join(SINGULARITY_DIR, "worktrees")`) and `build.ts` already imports from its
  barrel (`markWorktreeOpStart`) — so adding the writer there introduces **no new
  cross-plugin edge** and no boundary violation.
- **DB provisioning is out of scope (F3).** The fork job is direct-enqueue-only
  (`plugins/database/plugins/fork/server/internal/fork-job.ts:17`), not triggered
  on boot, so a hand-written spec has no DB. F2 proves *identity from a static
  spec*; "create-empty-then-migrate" is F3. The static-spec verification below
  provisions DB `sonata` manually (a one-off idempotent fork).
- The socket-orphan sweep (`gateway/registry.go:356`) keys on `*.sock` files, not
  on git existence, so a fixed-name static spec dir is never reaped.

## Design

### 1. New writer: `infra/worktree/server`

Add `plugins/infra/plugins/worktree/server/internal/spec.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { worktreesDir } from "./worktree-op";

export interface WorktreeSpec {
  /** Namespace = subdomain = SINGULARITY_WORKTREE. Spec dir basename. */
  name: string;
  /** Absolute path to the backend working dir (`bun bin/index.ts` runs here). */
  server: string;
  /** Absolute path to web/dist. Omitted for API-only namespaces (central). */
  web?: string;
}

/**
 * Register a servable namespace by writing its `spec.json`. The gateway's
 * fsnotify watcher picks it up; identity flows from the dir basename to
 * `SINGULARITY_WORKTREE`. Returns the spec.json path. The single seam shared by
 * the dev build (identity from git) and the release launcher (fixed name, no git).
 */
export function writeWorktreeSpec({ name, server, web }: WorktreeSpec): string {
  const dir = join(worktreesDir(), name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "spec.json");
  writeFileSync(path, JSON.stringify(web ? { server, web } : { server }, null, 2) + "\n");
  return path;
}
```

Re-export `writeWorktreeSpec` and the `WorktreeSpec` type from the barrel
`plugins/infra/plugins/worktree/server/index.ts`.

Rationale for a new `spec.ts` (not co-locating in `worktree.ts`/`worktree-op.ts`):
`worktree.ts` is async git CRUD and `worktree-op.ts` is push/op-lock tracking;
spec registration is a distinct, sync, git-free concern. One file, one
responsibility.

### 2. Route `build.ts`'s three sites through the writer

Replace each inline `mkdirSync` + `writeFileSync(join(WORKTREES_DIR, …, "spec.json"), …)`
with a `writeWorktreeSpec(...)` call:

- `:766-771` → `writeWorktreeSpec({ name: "central", server: centralDir })`
- `:1044-1054` → `writeWorktreeSpec({ name, server: spec.server, web: spec.web })`
  (inline the existing `spec` object's `server`/`web` values)
- `:1066-1072` → `writeWorktreeSpec({ name: "central", server: centralDir })`

Add `writeWorktreeSpec` to the existing
`import { markWorktreeOpStart, clearWorktreeOp } from "@plugins/infra/plugins/worktree/server"`.
After the rewrite, `WORKTREES_DIR` has no remaining use in `build.ts` (only at
`:766/:1049/:1067`) — drop it from the `../paths` import. `worktreeDataDir` and
the other path imports stay.

The central comments at `:756-761` and `:1063-1064` (why central is written
early + re-registered, always pointing at main's `central-core/`) are preserved —
they document call-site intent, not the mechanics the writer now owns.

### What F2 does *not* touch

- Gateway: unchanged.
- F1's composition selectors / `vite.config.ts` / registries: unchanged.
- No release launcher yet — F2 only proves the static-spec path works by hand;
  the launcher that calls `writeWorktreeSpec` with a fixed name + create-empty
  DB is F3.

## Critical files

- `plugins/infra/plugins/worktree/server/internal/spec.ts` — **new** writer.
- `plugins/infra/plugins/worktree/server/index.ts` — re-export the writer + type.
- `plugins/framework/plugins/cli/bin/commands/build.ts` — three call sites + drop
  `WORKTREES_DIR` import.
- `plugins/infra/plugins/worktree/CLAUDE.md` — add `writeWorktreeSpec` to the
  reference (regenerated by `./equin build` docgen).

## Verification

**A. Dev regression (the extraction is behavior-preserving).**
1. `./equin build` from the worktree.
2. Confirm `~/.singularity/worktrees/<wt>/spec.json` is byte-identical in shape to
   before (`{ "server": …, "web": … }`) and `~/.singularity/worktrees/central/spec.json`
   is `{ "server": … }`.
3. Open `http://<wt>.localhost:9000` — serves normally; `central` (`/api/auth/*`)
   still routes. `./equin check plugins-registry-in-sync` green, `git status`
   clean.

**B. Static-spec identity (the F2 proof — fixed name, no git).**
1. `./equin build --composition sonata` in this worktree → produces the
   filtered `server.composition.generated.ts` + filtered dist at `web/dist`
   (`livePath`).
2. Provision the DB once (F3's job is to automate this; here it's manual and
   idempotent), e.g. via MCP `query_db` to confirm absence, then a one-off
   `forkDatabase("singularity", "sonata")` so DB `sonata` carries the full schema.
3. With **no git operation**, write the static spec by invoking the new writer
   directly (e.g. `bun -e` importing `writeWorktreeSpec`):
   `writeWorktreeSpec({ name: "sonata", server: "<root>/plugins/framework/plugins/server-core", web: "<livePath>" })`.
4. Load `http://sonata.localhost:9000` (Playwright screenshot) → only Sonata
   chrome (no agent-manager/studio), served from a fixed-name namespace with no
   git worktree.
5. Confirm via MCP `query_db` (or backend logs) that the backend connected to DB
   `sonata` (`SINGULARITY_WORKTREE=sonata`). `git status` clean throughout.

> Note: step B's manual DB provisioning is the one piece F2 intentionally leaves
> manual — automating it as create-empty-then-migrate is F3. F2's deliverable is
> the writer + the single shared code path; step B proves identity is fully
> decoupled from git.
