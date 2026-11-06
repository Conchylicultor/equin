import {
  registeringPlugin,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";
import { isHostSingleton } from "@plugins/infra/plugins/paths/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  newDeclState,
  registerDecl,
  type DaemonDecl,
  type DaemonRestart,
  type DaemonRuntime,
  type DaemonSpec,
  type DaemonWhere,
} from "./registry";
import {
  attachIn,
  launchDetachedIn,
  spawnProcessIn,
  spawnWorkerIn,
} from "./supervise";

function runtimeFor(where: DaemonWhere): DaemonRuntime {
  return {
    scope: where === "every-worktree" ? "every-worktree" : "main",
    get runsHere() {
      if (where === "main") return isMain();
      if (where === "host-singleton") return isHostSingleton();
      return true;
    },
    declaredIn: registeringPlugin,
  };
}

/**
 * Declare a long-lived process or thread a backend runs on its own — the ONE
 * way to start one in server code (a raw `Bun.spawn` / `new Worker` is a lint
 * error elsewhere). The declaration names it, describes it, and fixes where
 * it runs and how it restarts; each `spawnProcess` / `spawnWorker` /
 * `launchDetached` / `attach` starts one instance of it.
 *
 * Every declaration is an entry under Long-lived processes in Debug →
 * Background activity: its instances (pid, since when, restarts, last exit,
 * memory and CPU) and each incarnation as a run.
 *
 * ```ts
 * export const probeDaemon = defineDaemon({
 *   name: "paging-probe.probe",
 *   description: "Measures event-loop lag in a twin process under memory pressure.",
 *   startedBy: "boot",
 *   where: "main",
 *   restart: { kind: "backoff", healthy: "survival" },
 * });
 * // register: [probeDaemon]
 * const p = probeDaemon.spawnProcess({ instance: "lean", argv, onStderrLine });
 * await p.stop();
 * ```
 */
export function defineDaemon<const R extends DaemonRestart>(
  spec: DaemonSpec<R>,
): DaemonDecl<R> & Registration {
  if (spec.onCodeAdopted === "stop" && spec.startedBy !== "on-demand") {
    throw new Error(
      `[daemon] ${spec.name}: onCodeAdopted "stop" needs startedBy "on-demand" — a boot daemon stopped on adoption would stay down until the next boot`,
    );
  }
  const state = newDeclState(spec, runtimeFor(spec.where));
  const decl = {
    name: spec.name,
    _kind: "daemon" as const,
    _factory: "defineDaemon" as const,
    _doc: { label: spec.name, detail: spec.description },
    register() {
      registerDecl(state);
    },
    spawnProcess: (opts: Parameters<typeof spawnProcessIn>[1]) =>
      spawnProcessIn(state, opts),
    spawnWorker: (opts: Parameters<typeof spawnWorkerIn>[1]) =>
      spawnWorkerIn(state, opts),
    launchDetached: (opts: Parameters<typeof launchDetachedIn>[1]) => {
      assertNever(spec);
      return launchDetachedIn(state, opts);
    },
    attach: (opts: Parameters<typeof attachIn>[1]) => {
      assertNever(spec);
      return attachIn(state, opts);
    },
  };
  // The conditional type hides launchDetached / attach on a supervised
  // declaration; the runtime object carries them guarded.
  return decl as unknown as DaemonDecl<R> & Registration;
}

function assertNever(spec: DaemonSpec): void {
  if (spec.restart.kind !== "never") {
    throw new Error(
      `[daemon] ${spec.name}: launchDetached / attach need \`restart: { kind: "never" }\` — nothing can respawn a process this backend is not the parent of`,
    );
  }
}
