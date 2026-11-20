import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { declareRuntimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { settleDeclaredDataDirMoves } from "@plugins/infra/plugins/paths/core";
import { recordMemoryCheckpoint } from "../core/profiler";
import { bootPluginGraph, runShutdownHooks } from "../core/boot-stages";
import { installProcessCrashListeners } from "../core/process-crash-listeners";
import {
  declareComposedHome,
  declareComposedWebPlugins,
} from "../core/composed-web-plugins";
import { declareExecAdmission, type ExecAdmission } from "../core/schema-role";

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
// WHY THIS LIVES IN `cli/`: an exec process IS a `./equin` command process
// — the future `supervised-exec` verb — and `cli/` is a runtime barrel, so
// `@plugins/framework/plugins/server-core/cli` is a legal cross-plugin import
// while `bin/` is not (R4 admits only runtime barrels, which is why nothing may
// import into a `bin/` path). This barrel declares no command of its own, the
// same shape the four shared-CLI-machinery barrels under `framework/cli/plugins`
// already have, so it is not in `cli.generated.ts` and is not loaded on every
// `./equin` invocation.
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
// - **`onSettled`** (`runSettledPhase`, the warm-up drain). Heavy,
//   deliberately-post-serving work whose whole justification is that a
//   long-lived backend will answer requests from it. Not imported here, so an
//   exec child has no path to it.
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
 * boot) throws — or the status `opts.exitCodeFor` picks for that error. A
 * short-lived child that returned to its caller could linger on an open pool
 * or listener, and a supervised run whose child never exits stays
 * in flight forever — so exiting is part of the contract, not the caller's
 * responsibility.
 */
export async function runExec(
  namespace: Namespace,
  body: () => void | Promise<void>,
  opts: {
    /**
     * The exit status for a failure — of the boot or of `body` — when it is not
     * plain `1`. The caller's classification, since only the caller knows what
     * its spawner can do with a distinct status (a supervised child answers
     * EX_TEMPFAIL for a failure its spawner should retry later). Anything it
     * does not claim exits 1.
     */
    readonly exitCodeFor?: (err: unknown) => number;
    /**
     * The host admission this process was booted under, when one bounds it
     * (a supervised child's `--admit` slot): given back while the boot only
     * waits — its database's owner setting the schema up for this code
     * (`SchemaRole`'s `yieldAdmission`) — so a waiter holds no slot.
     */
    readonly admission?: ExecAdmission;
    /**
     * Start only what the work needs instead of the whole app: the plugin
     * that declared it (`root`, a `pluginPath`) and the contributed lists it
     * reads whole (`reads`, debug names). See `resolveStartSet` and the list
     * rule (`declarePartialStart`): a complete list this set does not wholly
     * hold throws when read. `label` names the work in that error, `fix`
     * says how its reader makes a list start whole. Absent: the whole app.
     */
    readonly start?: {
      readonly root: string;
      readonly reads: readonly string[];
      readonly label: string;
      readonly fix: (kind: string) => string;
    };
  } = {},
): Promise<never> {
  declareRuntimeNamespace(namespace);
  if (opts.admission !== undefined) declareExecAdmission(opts.admission);
  // The same crash listeners `serve` installs (`../core/process-crash-listeners.ts`): a
  // throw or rejection that escapes `body`'s await chain (a detached promise, a
  // timer) is filed through `processCrashSink` like the serving backend's.
  // `body`'s own throw is not a crash: it is caught below and exits with the
  // run's failure status, which the supervising ledger records.
  installProcessCrashListeners();
  recordMemoryCheckpoint("boot-start");
  let ordered;
  // The graph loads from the checkout this process runs from. On main that
  // is a SLOT (infra/git/main-slots), held shared for this process's whole
  // life by the CLI bootstrap (an exec child is a `./equin` process —
  // `main-slots/boot-lease`), so no build checks it out while any module,
  // lazy import or spawned script may still be read from it; a worktree is
  // rewritten only by its own agent's commands. No push writes into either.
  try {
    // Dynamic on purpose. A command DECLARATION (`cli/index.ts`) is measured by
    // `cli:command-declarations-light`, which stops at dynamic-import edges — so
    // the future `supervised-exec` declaration that imports this barrel keeps a
    // trivial static closure, and neither the registry nor `spec.json` is read
    // by a `./equin` invocation that is not this one.
    // The declared data-dir moves, before the graph reads a path — inspected
    // only: an exec child never moves shared data (infra/paths CLAUDE.md,
    // § Moving a declared dir).
    await settleDeclaredDataDirMoves({ perform: false });
    const { serverEntries, machineEntries, serverComposition } =
      await import("../bin/active-runtime");
    // The same answer `serve` declares, off the same registry.
    declareComposedWebPlugins(serverComposition.webPlugins);
    declareComposedHome(serverComposition);
    // The same graph a serving desktop backend boots: both halves — whole,
    // or the part the work needs (`opts.start`), resolved from it with the
    // build's contributor table (loaded only then: no serving path reads it).
    const entries = [...serverEntries, ...machineEntries];
    // The data lists, as the build wrote them (`installListEntries`).
    const listEntries = {
      kind: "written" as const,
      entries: (await import("../core/list-entries.generated"))
        .serverListEntries,
    };
    ordered = await bootPluginGraph(
      opts.start === undefined
        ? { mode: "exec", entries, listEntries }
        : {
            mode: "exec",
            entries,
            listEntries,
            start: {
              ...opts.start,
              contributors: (await import("../core/contributors.generated"))
                .serverContributors,
            },
          },
    );
    await body();
  } catch (err) {
    console.error("[exec] failed", err);
    if (ordered) await runShutdownHooks(ordered);
    process.exit(opts.exitCodeFor?.(err) ?? 1);
  }
  await runShutdownHooks(ordered);
  process.exit(0);
}
