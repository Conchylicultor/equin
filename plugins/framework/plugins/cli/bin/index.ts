import {
  type EnsureDepsResult,
  ORPHAN_EXIT_CODE,
  ensureDeps,
  installOrphanGuard,
  reexecAfterInstall,
  reexecUnderLockedBun,
  takeReexecBudget,
} from "@plugins/framework/plugins/cli/plugins/bootstrap/cli";

/**
 * `./singularity`'s entrypoint — and deliberately NOT the CLI. Four ordered
 * steps that must all be able to run with `node_modules` absent or stale:
 *
 *   1. arm the orphan guard
 *   2. `await ensureDeps()`   — this checkout's `node_modules` is correct
 *   3. if `node_modules` changed (installed here, or by a command we waited on),
 *      hand the command to a fresh process and exit
 *   4. `await import("./cli")` — the commander program, from ./cli.ts
 *
 * WHY THIS FILE EXISTS. The wrapper used to be:
 *
 *   set -e; cd "$(dirname "$0")"; bun install --silent; exec bun …/bin/index.ts "$@"
 *
 * `bun install` can genuinely fail (bun 1.3.13 has no install mutex, so two
 * concurrent installs in one checkout race on `clonefileat` and one loses).
 * `set -e` then aborted the wrapper before `exec`, and `--silent` meant nothing
 * was printed: every subcommand looked like it had failed on its own, with exit
 * 1 and zero bytes of output — `./singularity check` reading as "checks failed"
 * when no check ever ran. The fix is structural rather than better error
 * handling in shell: there is now NO step before the CLI process, so no step can
 * die before the CLI. The wrapper is a bare `exec`, and the install lives here,
 * inside a process that can attribute its own failures.
 *
 * THE IMPORT CONSTRAINT (the load-bearing part). This module's transitive
 * *static* import set must reach **no npm package** — node builtins, relative
 * repo files and `@plugins/*` aliases only. Static imports are hoisted above
 * every statement in the module, so a single `import { program } from
 * "commander"` here would resolve `commander` out of the very `node_modules`
 * that step 2 exists to repair — the fresh-checkout case would crash on an
 * unresolved module, which is the same class of pre-CLI death this whole file
 * removes. `commander` is exactly why `./cli.ts` exists, and why step 4 is a
 * *dynamic* import: it is the one form that resolves only after step 2 has
 * returned. Enforced by the `cli:bootstrap-package-free` check (the transitive
 * closure is measured with `Bun.build`, so it cannot drift from what actually
 * loads) — if you need a package, put the import in `./cli.ts`.
 *
 * All three current imports satisfy the constraint: `./orphan-guard` has zero
 * imports of its own, and `./ensure-deps` / `./reexec` are written under the
 * same rule (see their docblocks).
 *
 * THE PROCESS CONSTRAINT (step 3, and the reason it is not redundant with the
 * dynamic import). Bun's resolver caches directory listings from the moment it
 * loads this process's first modules, so a process whose `node_modules` changed
 * after it started cannot see the change: `plugins/framework/plugins/cli/node_modules`
 * is already cached as absent, and step 4 then fails with `Cannot find package
 * 'commander'` on every fresh checkout. That holds whether this process ran the
 * install or waited on `.install.lock` while another command did. The dynamic
 * import fixes WHEN resolution happens; step 3 fixes WHICH PROCESS does it. Full
 * reproduction and rationale: `./reexec.ts`.
 */

// The command runs in THIS process, whose ppid is the invoking shell — so it
// observes its own orphaning directly. Terminate when that shell dies, so an
// orphaned CLI never holds a host lock (the push mutex worst case) forever.
//
// FIRST, before the install: the guard must be armed for the whole lifetime of
// this process, install included, or an orphan could sit on the install lock —
// the one lock every other CLI invocation in this checkout queues behind.
//
// UNCONDITIONAL, and this file reads no argv at all. It used to match
// `process.argv[2]` against a hardcoded {build, check, push} set, which a CLI
// whose commands are plugin contributions cannot keep: this line runs before the
// install, so it cannot load the declarations that would answer the question.
// Arming for everything removes the question instead of re-answering it from a
// second copy. A command that is MEANT to outlive its shell declares
// `detachable` and the mapper disarms it once argv is parsed — see
// `./orphan-guard.ts`.
installOrphanGuard(() => process.exit(ORPHAN_EXIT_CODE));

// Take this invocation's re-exec budget out of the environment before anything
// is spawned (the install below included): it counts THIS chain of re-execs, and
// a descendant `./singularity` is a new invocation with a budget of its own.
const reexecBudget = takeReexecBudget();

// Run on the Bun `mise.lock` records, not whichever one the caller's PATH found.
// A long-lived caller (a backend booted before a lock bump, an old shell) hands
// us its boot-time Bun, and a build on the wrong Bun fails `bun-runtime` — on
// main that was the build meant to restart the backend onto the new Bun, so
// nothing recovered (2026-10-12). Before the install, so `bun install` runs on
// the locked Bun too. See `./locked-bun.ts` in the bootstrap plugin.
const lockedBun = await reexecUnderLockedBun(import.meta.path);
if (lockedBun.kind === "reexeced") process.exit(lockedBun.exitCode);
if (lockedBun.kind === "mismatch") console.error(`equin: ${lockedBun.reason}`);

// The one dependency chokepoint: freshness-gated (the common case is ~140 ms and
// silent — see its docblock for the measured breakdown), serialized against
// every other CLI-mediated install, and loud. On
// failure it throws a message written to be the entire story — which phase
// failed, the likely cause, and what to do — so print the message and stop.
// Deliberately no stack: the stack would name this bootstrap, not the problem.
let deps: EnsureDepsResult;
try {
  deps = await ensureDeps();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// An install happened — by this process, or by another command this one waited
// on — so THIS process's resolver cache predates the `node_modules` on disk and
// can no longer resolve an npm package (see the process-constraint note above,
// and `./reexec.ts` for the reproduction). Hand the user's command to a fresh
// process and exit with its status. Skipped entirely on the common fresh-stamp
// path, which is why it costs nothing.
if (deps.kind !== "fresh") {
  const outcome = await reexecAfterInstall(import.meta.path, reexecBudget);
  if (outcome.reexeced) process.exit(outcome.exitCode);
  // Budget spent — say so and fall through rather than loop. The reason is the
  // whole story; see `reexecAfterInstall`.
  console.error(`equin: ${outcome.reason}`);
}

// Only now is `node_modules` known good AND resolvable from this process, so
// only now may a module that imports npm packages be resolved. Dynamic, and
// after the await, for that reason alone. Extensionless like every other import
// here: `allowImportingTsExtensions` is off, so a `./cli.ts` specifier is a
// TS5097 type error.
await import("./cli");
