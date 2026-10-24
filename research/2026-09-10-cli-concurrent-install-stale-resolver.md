# A CLI command that waits on another command's install must restart before loading the CLI

## Context

Running `./equin test <path>` and `./equin build` at the same time in one
worktree can kill the build before it starts:

```
Another build is in progress; waiting...
error: Cannot find package 'commander' from '.../plugins/framework/plugins/cli/bin/cli.ts'
```

Re-running the build alone works. Agents are told to background both commands, so
launching them together is normal, and neither line points at the cause.

### What actually happens

The two installs do **not** run at the same time. They are already serialized:
`ensureDeps()` (`plugins/framework/plugins/cli/plugins/bootstrap/cli/ensure-deps.ts`)
takes `.install.lock` around `bun install`. The failure is one step later:

1. `test` starts first. Its dependency stamp is stale (or `node_modules` is missing, as
   in a fresh worktree), so it takes `.install.lock` and runs `bun install`.
2. `build` starts. Bun has already begun caching directory listings while loading the
   bootstrap — including "`plugins/framework/plugins/cli/` has no `node_modules`".
3. `build` sees the same stale stamp and waits on `.install.lock`. The wait message it
   prints is `acquireBuildLock`'s hardcoded **"Another build is in progress"** — false:
   it is waiting on `test`'s dependency install.
4. `test`'s install finishes. `build` gets the lock, re-checks, finds the stamp fresh,
   and returns `{ installed: false }`.
5. The bootstrap (`plugins/framework/plugins/cli/bin/index.ts`) only re-execs when
   `installed` is true, so `build` stays in its own process and runs
   `await import("./cli")`. Its resolver still believes `cli/node_modules` is absent,
   so `commander` is not found.

`reexec.ts` already documents this exact resolver-cache bug and fixes it for the
process that ran the install. Its rule — "the process that runs the install must not
go on to resolve an npm package" — is too narrow. The real rule is: **a process that
saw `node_modules` stale must not resolve an npm package, whoever did the install.**
`EnsureDepsResult.installed` answers "did *I* install?", which is the wrong question.

## Design

### 1. Make the result say whether `node_modules` changed under this process

Replace `EnsureDepsResult { installed: boolean }` with a discriminated union:

```ts
export type EnsureDepsResult =
  /** Stamp matched on the first look. node_modules did not change during this call. */
  | { kind: "fresh" }
  /** This call ran `bun install`. */
  | { kind: "installed" }
  /** Stale on the first look; another command in this checkout installed while we
   *  waited on `.install.lock`, so the under-lock re-check found it fresh. */
  | { kind: "installed-by-other" };
```

The type docblock states the caller constraint once: every kind except `fresh` means
`node_modules` changed after this process started resolving modules, so it must not
import an npm package in-process.

This removes the bug's spelling: there is no longer a "false" arm that a stale-cache
process can read as "all good". Each caller has to handle the concurrent case.

Changes in `ensureDeps()`:
- Fast path returns `{ kind: "fresh" }`.
- Under-lock re-check that finds the stamp fresh returns `installed-by-other`.
  It prints nothing of its own: the lock's wait line (which now names the holder
  pid) already told the reader, and `ensureDeps`' callers report retrospectively.
- Successful install returns `{ kind: "installed" }`.

(Implementation note: an earlier draft carried a `holderPid` and an extra log
line in `ensureDeps`; dropped — the build's stage 1 would have printed the same
sentence twice, and the pid is already on the wait line.)

### 2. Callers

- `bin/index.ts` (bootstrap): re-exec when `deps.kind !== "fresh"` (was: when
  `installed`). Update the process-constraint comment.
- `reexec.ts`: update the docblock. The bug is no longer "never a race". Add the
  concurrent variant and restate the rule as "the process that saw `node_modules`
  stale". Budget (`MAX_REEXECS = 2`) is unchanged: the re-exec'd child sees a fresh
  stamp and goes straight to the CLI.
- `build/cli/internal/app-artifacts.ts` stage 1: log line per kind —
  `Dependencies already up to date.` / `Installed dependencies.` /
  `Dependencies were installed by another command in this checkout.`. No behavior
  change: by stage 1 the build process already loaded the CLI, and everything that
  uses the new packages (vite, drizzle-kit, tsc) runs as a child process.
- `push/cli/run.ts`: ignores the result today; unchanged apart from compiling.

### 3. The lock's wait message names what it is waiting for

`acquireBuildLock` guards two different locks but always says "Another build is in
progress". Rename it `acquireCheckoutLock` and add a **required** `what` option, so a
caller cannot omit it (a type error, not a doc convention):

```ts
acquireCheckoutLock(path, { what: "dependency install" })   // ensure-deps.ts
acquireCheckoutLock(path, { what: "build", describeHolderActivity })  // app-artifacts.ts
```

The three messages become (pid included when the lock file has one):
- first wait: `Waiting for the dependency install another command is running in this
  checkout (pid 4242)...`
- stale: `Still waiting (65s) for the dependency install; held by pid 4242.`
- timeout: `Timed out after …ms waiting for the dependency install lock at … `

Rename touches: `build-lock.ts` (file can stay; export renamed), the bootstrap barrel
`bootstrap/cli/index.ts`, `ensure-deps.ts`, `app-artifacts.ts`, `build-lock.test.ts`,
`ensure-deps.test.ts`. Plugin docs regenerate on build.

## Out of scope

The already-documented residual hazard in `ensureDeps` stays as is: a process whose
first look was *fresh*, while someone edits a `package.json` and another command
relinks `node_modules` mid-run. That is a different trigger (a dep-input edit during a
run, or a bare `bun install` that takes no lock) and is not what was reported.

## Files

- `plugins/framework/plugins/cli/plugins/bootstrap/cli/ensure-deps.ts` — result union, logging
- `plugins/framework/plugins/cli/plugins/bootstrap/cli/build-lock.ts` — rename + required `what`
- `plugins/framework/plugins/cli/plugins/bootstrap/cli/reexec.ts` — docblock
- `plugins/framework/plugins/cli/plugins/bootstrap/cli/index.ts` — barrel export names
- `plugins/framework/plugins/cli/bin/index.ts` — re-exec condition
- `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts` — log per kind, lock rename
- `plugins/framework/plugins/cli/plugins/bootstrap/cli/ensure-deps.test.ts`, `build-lock.test.ts`

## Verification

1. **Reproduce first, before any edit.** This worktree has no `node_modules` today, so it
   is exactly the failing state. Launch two cheap CLI commands together, e.g.
   `./equin check --list` twice in parallel (backgrounded). Expect one to die with
   `Cannot find package 'commander'` after "Another build is in progress". If it does not
   reproduce, stop and re-diagnose before changing anything.
2. Unit tests — `./equin test plugins/framework/plugins/cli/plugins/bootstrap`:
   - the existing "under-lock re-check skips an install the lock holder already did"
     test now asserts `kind: "installed-by-other"` and the pid in the log line;
   - fast path asserts `kind: "fresh"`, install path asserts `kind: "installed"`;
   - `build-lock.test.ts` asserts the wait line names `what`.
3. After the fix, wipe this worktree's `node_modules` again (the root one and every
   workspace one) and repeat step 1: both commands succeed; the waiting one prints the
   dependency-install wait line, the "installed by another command" line, then runs.
4. Repeat the reported pairing: `./equin test plugins/framework/plugins/cli/plugins/bootstrap`
   and `./equin build` backgrounded together from a stale stamp; both finish,
   `build-status.json` reads `status: ok`.
5. `./equin check` (includes `cli:bootstrap-package-free`, type-check, plugin docs).
