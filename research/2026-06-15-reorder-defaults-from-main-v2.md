# Reorder "default for everyone" — landing from main (v2)

## Context

v1 (`research/2026-06-12-reorder-structural-vs-personal-edits.md`, landed in
`0538352de`) made structural "default for everyone" reorder edits **stageable,
reviewable, and applyable — but only from inside a worktree session**. The whole
flow is bound to the worktree you sit in:

1. **Stage** — writes a row to `reorder_staged_default` in *the current namespace's
   own DB* (worktree fork, or `singularity` for main).
2. **Review** — the "Reorder Defaults" pane reads that *same local DB*.
3. **Apply** — `writeGitLayerOverride` writes `config/<plugin>/<slot>.jsonc` straight
   into `REPO_ROOT` = **the current checkout's working tree**.
4. **Land** — you then run `./equin push` *from that worktree*; the file rides
   the normal branch → merge → push flow.

**What's broken:** in the **main** namespace (`singularity.localhost:9000`) steps 1–3
work, but **step 4 has no safe path** — main has no worktree branch to push, and the
only way to push from main is `./equin push --from-main` (the explicitly
dangerous, approval-gated path). So a main-app user can stage and even write the file,
but cannot land it.

**Scope (confirmed with the user):** v2 fixes *landing from main only* — a **manual
"Commit to main"** action. **No async/periodic auto-push** (no scheduled job, no draft
branch). The deferred async sync is explicitly out of scope for now.

**Reframing that shapes v2 (confirmed with the user):** worktrees are *ephemeral test
sandboxes* — experiments only. **Real "default for everyone" edits come from main.**
This collapses the elaborate "app-wide / central store / cross-worktree" design the v1
doc sketched under *Future: app-wide*:

- **No central store, no cross-worktree sharing, no apply-target selector.** The
  staging table already exists in the `singularity` (main) DB (v1's migration shipped
  there), and main's DB is never swept — it is already a durable, sufficient home for
  real edits. Worktree staging stays a local-testing nicety.
- **The only real gap is landing.** Fix it with the user's idea: land via a **throwaway
  git worktree created off `main`** — write the config files there, commit, push, remove
  the worktree. This decouples landing from whichever checkout you edited in, works
  identically from main, and needs no `--from-main`.

## Decisions (locked with the user)

- **Staging store: unchanged.** Keep v1's per-namespace `reorder_staged_default` table.
  Real edits land from main (rows in the `singularity` DB); the async cron runs on the
  main runtime and drains exactly those rows. Worktree-staged rows are only landed if a
  tester manually applies them — coherent with "worktrees are throwaway."
- **Landing = throwaway worktree off `main`** (replaces the v1 write-into-current-checkout
  + manual-push path entirely).
- **Single landing trigger — manual "Commit to main"** (explicit user action in the
  review pane) → lands **directly on `main`** by reusing `./equin push` inside the
  throwaway worktree. Explicit click = sanctioned per-action approval.
- **No async sync** — no scheduled job, no draft branch. (Deferred.)
- **Non-blocking:** the landing runs inside a **`defineJob`** (heavy git/push work must not
  block an HTTP handler). Manual Apply *enqueues* the job and returns immediately.

## Architecture (data flow)

```
stage (main app, "Everyone" toggle)        ── unchanged ──▶ reorder_staged_default (main DB)
                                                                   │
                          manual: Apply / Apply all (review pane)  │
                                         │                         ▼
              reorder.land-defaults.enqueue({slotIds})  ──▶  landing job (non-blocking):
                                                              1. repoRoot = ensureMainWorktreeRoot()
                                                              2. git worktree add -b <branch> <tmp> main
                                                              3. writeGitLayerOverride(<tmp>, row) ×N  (v1 hash logic, baseDir param)
                                                              4. ./equin push -m  (cwd=<tmp>) → merges to main
                                                              5. git worktree remove <tmp> --force
                                                              6. delete landed rows → stagedReorderDefaultsResource.notify()
```

Stage + review surfaces are **unchanged** from v1. Only the **landing mechanism** and
the **async job** are new.

## Phase 1 — Parameterize the config writer

**`plugins/reorder/plugins/staging/server/internal/git-layer-writer.ts`** — change
`writeGitLayerOverride` to take an explicit base directory instead of the module-level
`REPO_ROOT`:

```ts
export function writeGitLayerOverride(baseDir: string, args: {
  slotId: string; pluginId: string; items: unknown[];
}): void
```

All path construction (`join(baseDir, "config", hierarchyPath, …)`) and the **hash
logic stays byte-for-byte** (read `<slot>.origin.jsonc` → strip `// @hash` → `computeHash`
of origin body → atomic tmp+rename write of `<slot>.jsonc` with that hash). Only the
base changes from `REPO_ROOT` (current checkout) to the throwaway worktree path. This is
the v1 invariant that keeps `config-origins-in-sync` green.

## Phase 2 — Landing routine + the job

**New `plugins/reorder/plugins/staging/server/internal/land.ts`** — pure server logic:

```ts
export async function landDefaults(rows: StagedReorderDefault[]): Promise<void>
```

Steps (all via `Bun.spawn([GIT, "-C", dir, …])`, the established server-side git pattern):
1. `repoRoot = await ensureMainWorktreeRoot()` (from `@plugins/infra/plugins/worktree/server`).
2. `branch = "reorder-land-<ts>"`; `wtPath = join(repoRoot, ".claude/worktrees", "<slug>")`.
3. `git -C <repoRoot> worktree add -b <branch> <wtPath> main`.
4. For each row: validate `descriptor.schema.safeParse({ items: row.items })`
   (fail-loud, skip + log on invalid — never write a malformed tree); then
   `writeGitLayerOverride(wtPath, row)`.
5. `git -C <wtPath> add -A`.
6. `Bun.spawn(["./equin", "push", "-m", msg], { cwd: wtPath })` — reuses the CLI's
   push lock, checks, rebase, merge-to-main, push (no reinvention; no `--from-main`).
7. `git -C <repoRoot> worktree remove <wtPath> --force` (in a `finally`, best-effort).

> The `git worktree add` is the lightweight path (`setupWorktree` confirms it triggers
> **no** DB fork / gateway registration / build). We create the worktree directly to
> control the branch name. `ensureMainWorktreeRoot()` works from any runtime, so the job
> is runtime-agnostic.

**New `plugins/reorder/plugins/staging/server/internal/land-job.ts`** — the manual
landing job (non-blocking; **no `schedule`** — enqueue-only):

```ts
export const landDefaultsJob = defineJob({
  name: "reorder.land-defaults",
  input: z.object({
    slotIds: z.array(z.string()).optional(),          // undefined = all staged
  }),
  event: z.never(),
  dedup: "singleton",                                 // serialize lands (one push at a time)
  async run({ slotIds }) {
    const rows = await loadRows(slotIds);             // all, or just slotIds
    if (rows.length === 0) return;
    await landDefaults(rows);
    await deleteRows(rows.map(r => r.slotId));         // drain on success
    stagedReorderDefaultsResource.notify();
  },
});
```

- **Manual Apply** enqueues `{ slotIds:[id] }`; **Apply all** enqueues `{}` (all rows) —
  one push for the batch.

Register `landDefaultsJob` in the staging server barrel's `register` array.

## Phase 3 — Endpoints + handlers (non-blocking)

**`plugins/reorder/plugins/staging/core/endpoints.ts`** — `applyReorderDefault` and a
new `applyAllReorderDefaults` (`POST /api/reorder/staged-defaults/apply-all`).

**`plugins/reorder/plugins/staging/server/internal/handlers.ts`:**
- `applyReorderDefault` (per-slot): assert the row exists (404) → `landDefaultsJob.enqueue({ slotIds:[slotId] })` → return 202. **No inline git/push.** The row is drained by the job on success; the live resource updates via `notify()`.
- `applyAllReorderDefaults`: `landDefaultsJob.enqueue({})` → 202.
- `discardReorderDefault`: unchanged.
- The git-layer write + row delete move *out* of the handler into the job (above).

## Phase 4 — Review UI wiring (small)

**`plugins/reorder/plugins/staging/web/`** — add `useApplyAllReorderDefaults`
(`useEndpointMutation`).

**`plugins/review/plugins/reorder-defaults/web/`:**
- Wire **"Apply all"** to the new batch endpoint (replaces the current per-row client
  loop — one push, not N).
- Relabel per-slot **Apply → "Commit to main"** and add a one-line caption that applying
  pushes to `main`. Show a transient "committing…" state until the row disappears
  (resource `notify` after the job lands).

## Reused infra (no reinvention)

- `@plugins/infra/plugins/worktree/server` — `ensureMainWorktreeRoot()`, `removeWorktree()`,
  worktree path convention (`<root>/.claude/worktrees/<slug>`), `PUSH_LOCK_PATH`.
- `@plugins/infra/plugins/paths/server` — `GIT` binary constant, `isMain()`.
- `@plugins/infra/plugins/jobs/server` — `defineJob` (cron main-only; `enqueue` on demand).
- `@plugins/config_v2/core` — `computeHash`, `stringifyConfigValue`, `parseJsonc` (already
  used by the v1 writer).
- `./equin push` (CLI subprocess) — reuses the entire lock + checks + merge flow;
  invoking the CLI as a subprocess from server code is already the established pattern
  (the push flow itself shells out to `… check`).

Boundary note: `staging/server` importing the `worktree/server` and `jobs/server`
**barrels** is legal (runtime barrels, no cycle — infra doesn't depend on reorder).

## Files

- `plugins/reorder/plugins/staging/server/internal/git-layer-writer.ts` — add `baseDir` param
- `plugins/reorder/plugins/staging/server/internal/land.ts` — **NEW** throwaway-worktree landing
- `plugins/reorder/plugins/staging/server/internal/land-job.ts` — **NEW** `reorder.land-defaults` job (enqueue-only)
- `plugins/reorder/plugins/staging/server/internal/handlers.ts` — Apply → enqueue (non-blocking)
- `plugins/reorder/plugins/staging/server/index.ts` — register job, wire `apply-all`
- `plugins/reorder/plugins/staging/core/endpoints.ts` — add `applyAllReorderDefaults`
- `plugins/reorder/plugins/staging/web/*` — `useApplyAllReorderDefaults`
- `plugins/review/plugins/reorder-defaults/web/*` — wire Apply-all, relabel, captions

## Verification

1. `./equin build` — no new migration expected (table unchanged); `./equin check`
   green (boundaries, `config-origins-in-sync`).
2. **From the *main* app** (`http://singularity.localhost:9000`): enter edit mode, flip
   scope to "Everyone", drag a slot → confirm one row in `reorder_staged_default`
   (`mcp__singularity__query_db`, `database: "singularity"`) and **no** personal config
   write.
3. Open review → "Reorder Defaults" → **Commit to main**. Observe: a throwaway worktree
   appears under `.claude/worktrees/` then is removed; `git log origin/main` shows the
   `config/<plugin>/<slot>.jsonc` commit; the staged row is drained; the pane updates live.
   No `--from-main` used.
4. **Apply all:** stage two "Everyone" edits, click "Apply all" → a single push lands both
   `config/…` files; both rows drained.
5. Negative: apply a malformed `items` (legacy `{order,hidden}`) → row skipped + logged,
   no file written, no push. Stage a non-promotable slot → still 403 at stage time (v1).

## Deferred (out of scope)

- **Async/periodic auto-sync** to main (scheduled job, draft branch). The landing job is
  built enqueue-only; adding a `schedule` + a draft-branch target later is additive.
