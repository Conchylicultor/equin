# Drizzle snapshot-chain integrity in CLI

## Context

Parallel-agent worktrees can each fork from the same main snapshot, add a migration, and then both land — producing a **Y-shaped** drizzle snapshot chain (two snapshots with the same `prevId`). The next agent to run `drizzle-kit generate` hits

```
Error: [...] are pointing to a parent snapshot: ... which is a collision
```

and `./equin build` silently says *"no schema change detected; ignoring"* because `cli/src/migrations.ts` spawns drizzle-kit with `stderr: "inherit"` and only checks `exitCode`. We just spent a rescue-commit reconstructing a stale snapshot manually (PR `414a4c2` shipped with `prevId` frozen to the pre-`add_spawned_by` state).

Three improvements that together close this hole structurally:

1. A new `snapshot-chain-intact` check that validates `server/src/db/migrations/meta/*.json` forms a linear chain — independent of drizzle-kit.
2. Register that check so it runs from both `./equin check` and `./equin push`. Because `push` runs `runChecks()` **after** rebasing onto main, any Y-fork caused by parallel merges is caught at push time, before it lands.
3. Capture drizzle-kit's stderr in `cli/src/migrations.ts` so collision errors are surfaced instead of being masked by the "no schema change detected" branch.

## Design

### 1. `cli/src/checks/snapshot-chain-intact.ts` (new)

Walks `server/src/db/migrations/meta/` and reads every `*_snapshot.json` (ignore `_journal.json`). Each snapshot exposes `id` (UUID) and `prevId` (UUID, or the null UUID `00000000-0000-0000-0000-000000000000` for the root).

Validates:

- Every `id` is unique.
- The null UUID appears as `prevId` exactly once (the root).
- Every non-root `prevId` resolves to a known `id`.
- No two snapshots share the same `prevId` (Y-fork detection).
- Traversal from the root reaches every snapshot (no orphan islands).

Failure message points the user at the two (or more) snapshot filenames involved so the fix is obvious: rebuild the newer snapshot against the current tip. Example:

```
FAIL
  snapshot chain has a Y-fork: two snapshots share prevId <uuid>:
    20260418_134114_d8da9e66__add_config_table_snapshot.json
    20260418_103000_abcdef12__add_spawned_by_snapshot.json
  hint: re-run `./equin build` to regenerate the branch's snapshot
        against the current main tip.
```

Model after `cli/src/checks/migrations-in-sync.ts`. Same `Check` shape from `cli/src/checks/types.ts`. Uses `fs` + `path` only — no drizzle-kit spawn, pure data validation.

### 2. Register in `cli/src/checks/index.ts`

Append to `CHECKS[]`:

```ts
import { snapshotChainIntact } from "./snapshot-chain-intact";

export const CHECKS: Check[] = [
  migrationsInSync,
  snapshotChainIntact,
  pluginsDocInSync,
  noRawEventSource,
  noRawSse,
  noRawWebsocket,
];
```

No push.ts change needed: push.ts already calls `runChecks()` at line 187 **after** the rebase at line 157, so when an agent pulls a new migration via rebase and then tries to push their own, the check runs against the post-rebase tree — exactly the state that would land on main.

### 3. `cli/src/migrations.ts` — surface drizzle-kit stderr

Current behavior (`cli/src/migrations.ts:40-50, 56-62`): spawns drizzle-kit with `stdout/stderr: "inherit"` and only inspects `exitCode`. If drizzle-kit exits 0 but printed a warning to stderr (e.g. some collision paths), the next branch hits

```
--migration-name was provided but no schema change was detected; ignoring.
```

which is actively misleading.

Fix: switch stderr to `"pipe"`, tee it to `process.stderr` live (so the user still sees it), *and* capture it to a buffer. After the process exits:

- If `exitCode !== 0`: already `process.exit(1)` — keep.
- If `exitCode === 0` but stderr contains known failure markers (`/error/i`, `/collision/i`, `/conflict/i`), exit with a clearer message pointing at the likely cause (chain collision → rebase against current main, rerun).

Keep stdout on `"inherit"` — drizzle-kit's progress output is already well-formatted.

Concretely:

```ts
const proc = Bun.spawn(cmd, {
  cwd: serverDir,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "pipe",
  env: { ...process.env, SINGULARITY_WORKTREE: worktreeName },
});

let stderr = "";
(async () => {
  for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
    process.stderr.write(chunk);
    stderr += new TextDecoder().decode(chunk);
  }
})();

const exitCode = await proc.exited;
if (exitCode !== 0) process.exit(1);
if (/error|collision|conflict/i.test(stderr)) {
  console.error(
    "\nError: drizzle-kit printed a diagnostic but exited 0. Treating as failure.\n" +
      "If this is a snapshot-chain collision, rebase onto origin/main and re-run ./equin build.",
  );
  process.exit(1);
}
```

### Why 1+2+3 close concern 4 structurally

- **1** makes the detection not depend on drizzle-kit at all. Pure structural validation catches Y-forks even if drizzle-kit silently tolerates them.
- **2** is the placement decision: because `push` runs the check *after* rebasing onto main, any collision caused by a parallel merge materializes and fails before the branch merges. The stale `prevId` can never land.
- **3** makes the remaining code path (`./equin build` during day-to-day dev) stop masking drizzle-kit's own collision errors behind "no schema change detected".

Auto-*rewriting* the snapshot at push time was considered and rejected — silently mutating committed files during a push is too surprising. The check fails loudly; user re-runs `./equin build` to regenerate. That keeps the fix explicit and reviewable.

## Critical files

- `cli/src/checks/snapshot-chain-intact.ts` — new check.
- `cli/src/checks/index.ts` — register in `CHECKS[]`.
- `cli/src/checks/types.ts` — reuse unchanged.
- `cli/src/checks/migrations-in-sync.ts` — reference pattern, untouched.
- `cli/src/migrations.ts` — stderr capture + error-pattern detection.
- `cli/src/commands/push.ts` — unchanged (runChecks after rebase at line 187 already provides the push-time gate).

## Reused surface area

- `Check` / `CheckResult` types in `cli/src/checks/types.ts`.
- `runChecks()` runner in `cli/src/checks/index.ts:18-44` — iterates `CHECKS[]`, prints pass/fail, aggregates. No change needed.
- Snapshot format documented in `server/CLAUDE.md` § "Schema change workflow" and confirmed by inspection: `{ id, prevId, version, dialect, tables, ... }`; root snapshot uses the null UUID.

## Verification

1. **Unit-level sanity** — after implementation, run `./equin check --snapshot-chain-intact` on a clean tree. Expect pass.
2. **Synthesize a Y-fork**: temporarily edit any non-root snapshot's `prevId` to match another snapshot's `prevId`. Re-run `./equin check --snapshot-chain-intact`. Expect fail with both filenames in the message. Revert the edit.
3. **Missing parent**: temporarily change a `prevId` to a random UUID. Re-run; expect fail pointing at that snapshot. Revert.
4. **Push-time gate**: on a throwaway branch, introduce a synthetic Y-fork as in (2), commit, and run `./equin push -m "test"`. Expect the rebase to succeed and the check to fail before any push to main. Branch stays local; main untouched.
5. **drizzle-kit stderr surfacing**: temporarily force drizzle-kit to a chain-collision state (as in the real incident) and run `./equin build --migration-name test`. Expect the collision error to be visible and the process to exit non-zero, **not** the "no schema change detected; ignoring" warning.
6. **Regression**: `./equin check` on main passes (all other checks still green).

## Scope notes

- Implementation should start by entering a fresh worktree (current worktree was just pushed and is done).
- No change to the `./equin push` flow itself — adding the check to `CHECKS[]` is sufficient because `runChecks()` already runs post-rebase.
- Auto-regeneration at push time (silent snapshot rewrite) is explicitly **out of scope** — detection + user-driven fix keeps the change reviewable.

## Follow-ups (out of scope)

- Content-addressed snapshot IDs (derive `id` from normalized snapshot content, which would make Y-forks impossible by construction). Worth exploring if collisions recur even with this gate.
- `./equin push` could optionally auto-rebase-and-regenerate snapshots when it detects a stale `prevId`, but that crosses a "mutate committed state silently" line that's best left off the hot path.
