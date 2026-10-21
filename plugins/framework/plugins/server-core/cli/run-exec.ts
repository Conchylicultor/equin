import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { declareRuntimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { recordMemoryCheckpoint } from "../core/profiler";
import { bootPluginGraph, runShutdownHooks } from "../core/boot-stages";

// ── `exec` — the short-lived boot mode ───────────────────────────────────────
//
// A process that runs ONE registered piece of work and exits: it needs the
// plugin graph loaded, `register` run, contributions collected (that is how a
// consumer finds its contributed sources and targets), the preload-declare
// assert, and `onReadyBlocking` completed (DB pool, migrations, config
// registry). It needs nothing else.
//
// It shares `../core/boot-stages.ts` with `serve` (`../bin/index.ts`) rather
// than re-implementing the sequence, because a second copy of a boot path that
// only runs when something is already unusual is the copy that rots — the lesson
// of release's recovery path
// (research/2026-09-01-global-supervised-run-survives-restart.md).
//
// WHY THIS LIVES IN `cli/`: an exec process IS a `./singularity` command process
// — the future `supervised-exec` verb — and `cli/` is a runtime barrel, so
// `@plugins/framework/plugins/server-core/cli` is a legal cross-plugin import
// while `bin/` is not (R4 admits only runtime barrels, which is why nothing may
// import into a `bin/` path). This barrel declares no command of its own, the
// same shape the four shared-CLI-machinery barrels under `framework/cli/plugins`
// already have, so it is not in `cli.generated.ts` and is not loaded on every
// `./singularity` invocation.
//
// WHAT `exec` SKIPS, AND WHY EACH WOULD BE WRONG HERE:
//
// - **Socket bind.** There is nothing to serve, and a child is never handed a
//   socket: only the serving entry point calls `readServingSocket()`, and
//   `servingSocketPath()` throws here. Binding would also collide with the
//   live backend's own socket.
// - **`markServerReady()`.** This process is not a serving backend. The flag is
//   read by exactly one caller, `GET /api/health/ready` (infra/health), and exec
//   mounts no routes — but setting it would still be a claim that is false.
// - **`onReady`.** This is where the background machinery starts: the
//   graphile-worker runners, the git ref watcher, the change-feed LISTEN
//   consumer, the conversations poller, the supervised-run reconciler. A child
//   that started them would compete with the live backend for queue jobs and
//   would re-attach to (or write off) runs it does not own.
// - **`onAllReady`.** Cron installation lives here (`jobs`' `installScheduledCronItems`).
//   A child installing crontab items is a duplicate scheduler.
// - **`drainWarmups`.** Heavy, deliberately-post-serving warm-up work whose whole
//   justification is that a long-lived backend will answer requests from it.
// - **The QoS boost.** `serve` raises MAIN's event-loop thread to
//   user-interactive; a background child must stay at background priority or it
//   defeats the priority isolation it was spawned under.
// - **Signal handlers.** A supervised child is cancelled by signalling its
//   process group, and the default disposition — terminate now — is what a
//   cancel wants. A graceful handler would delay it.
// - **The orphan-exit poll.** `serve` exits when reparented to init, because a
//   surviving backend after a gateway crash leaks. A detached supervised child is
//   *supposed* to be reparented to init; that poll would kill it immediately.
//
// WHAT `exec` DOES NOT SKIP: `register` and `onReadyBlocking` run in both
// modes. A hook there that makes a claim about the SERVING backend must check
// `getBootMode()` (`../core/boot-mode.ts`) — boot-events' `start` line is the
// example.
//
// `isMain()` is true in a child spawned by MAIN's backend, because the namespace
// its spawner hands it IS main's. Nothing gated on it fires here: every main-only
// side effect in the tree hangs off `onReady`, `onAllReady` or a warm-up, all of
// which exec skips.
//
// The namespace is a PARAMETER, declared before anything else runs. It names both
// the plugin registry this process boots (`bin/active-runtime`) and the Postgres
// database it talks to (`database`'s worktree pool), so an exec child talks to
// exactly the database its spawner meant — stated, never inherited. See
// research/2026-09-15-global-retire-ambient-worktree-env-runtime-identity.md.

/**
 * Boot this process in `exec` mode, run `body`, tear the runtime down and exit.
 *
 * ```ts
 * // in a CLI command that IS the short-lived child
 * await runExec(namespace, async () => {
 *   await runBackupTask(payload);
 * });
 * ```
 *
 * `namespace` is stated by the caller, which got it off its own `--namespace`
 * option. Guessing it from the checkout path is deliberately NOT done: it would
 * pick a database, and picking the wrong one silently is worse than refusing.
 *
 * It is declared FIRST, before a single plugin is imported, because the failure
 * otherwise arrives deep in the graph and describes the wrong thing entirely:
 * modules resolve namespace-scoped paths at module eval (`config_v2#machine`
 * its config dir, the per-worktree log dir), and a throw from one of them
 * surfaces as a TDZ error in whichever importer evaluated it first, burying the
 * one line that said what was actually missing.
 *
 * The whole boot is inside this call, so there is no way to obtain a
 * half-booted runtime: `body` runs only after the graph is loaded, registered,
 * its contributions collected and the `onReadyBlocking` barrier complete. There
 * is no runtime handle to pass around either — booting populates module-global
 * registries (the DB pool, the job registry, the contribution tables), and every
 * consumer already reads them through its own plugin's barrel.
 *
 * Returns `never`: the process exits 0 when `body` resolves and 1 when it (or
 * boot) throws. A short-lived child that returned to its caller could linger on
 * an open pool or listener, and a supervised run whose child never exits stays
 * in flight forever — so exiting is part of the contract, not the caller's
 * responsibility.
 */
export async function runExec(
  namespace: Namespace,
  body: () => void | Promise<void>,
): Promise<never> {
  declareRuntimeNamespace(namespace);
  recordMemoryCheckpoint("boot-start");
  let ordered;
  try {
    // Dynamic on purpose. A command DECLARATION (`cli/index.ts`) is measured by
    // `cli:command-declarations-light`, which stops at dynamic-import edges — so
    // the future `supervised-exec` declaration that imports this barrel keeps a
    // trivial static closure, and neither the registry nor `spec.json` is read
    // by a `./singularity` invocation that is not this one.
    const { serverEntries, machineEntries, hasCoreBarrel } =
      await import("../bin/active-runtime");
    ordered = await bootPluginGraph({
      mode: "exec",
      // The same graph a serving desktop backend boots: both halves.
      entries: [...serverEntries, ...machineEntries],
      hasCoreBarrel,
    });
    await body();
  } catch (err) {
    console.error("[exec] failed", err);
    if (ordered) await runShutdownHooks(ordered);
    process.exit(1);
  }
  await runShutdownHooks(ordered);
  process.exit(0);
}
