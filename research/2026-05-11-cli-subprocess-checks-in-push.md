# Fix stale CLI checks in `./equin push`

## Context

When `./equin push` runs, Bun loads `cli/src/checks/index.ts` at process start via static imports. The `CHECKS` array (18 built-in checks) is frozen at module evaluation time — before the rebase. After the rebase onto main (step 3 of push), the files on disk are updated with main's latest CLI code, but Bun's module cache still holds the pre-rebase check definitions.

**Real incident:** The `detail-sections` worktree was forked before `ed1be7cc` added the `noReexportDefault` check. Push rebased successfully, but ran the old check list from memory — the new check never ran, and violating code landed on main.

## Fix

Replace the two in-process `runChecks()` calls in `push.ts` with a **subprocess invocation** of `bun cli/src/index.ts check`. The subprocess loads fresh code from the rebased tree on disk.

This pattern already exists in `push.ts`: `regen-migrations` and `regen-docs` (lines 114, 119) are run as subprocesses for the same reason — they need to see the rebased file state.

### Changes

**`cli/src/commands/push.ts`**

1. Remove the `import { runChecks } from "../checks"` (line 5).

2. Add a helper that spawns checks as a subprocess with inherited stdio and returns a boolean:

```ts
async function runChecksSubprocess(root: string): Promise<boolean> {
  const proc = Bun.spawn(["bun", "cli/src/index.ts", "check"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await proc.exited) === 0;
}
```

3. Replace the two `runChecks()` call sites:

   - **`--from-main` path** (~line 258): `const ok = await runChecksSubprocess(await getWorktreeRoot());`
   - **Worktree path** (~line 324): `const ok = await runChecksSubprocess(await getWorktreeRoot());`

   The surrounding error messages and `process.exit(1)` stay unchanged — the subprocess's own stdout/stderr (per-check ok/FAIL lines) streams to the terminal, and the exit code maps to the boolean.

That's it. No other files change.

### Why not fix `build.ts` too?

`build.ts` also calls `runChecks()` in-process, but build doesn't rebase — the CLI code on disk matches what's in memory throughout the build. The stale-module problem is specific to push's mid-process rebase.

## Verification

1. `./equin build` — confirm the build still works (no changes to build).
2. `./equin check` — confirm checks still run standalone.
3. Simulated push: the subprocess check output should stream to the terminal identically to today's in-process output, and a failing check should still block the push with the contextual error message.
