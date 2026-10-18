import {
  registeringPlugin,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { defineBackgroundKind } from "@plugins/infra/plugins/background/plugins/catalog/server";
import {
  defineTimerIn,
  listTimerEntries,
  timerRecentRuns,
  type Timer,
  type TimerSpec,
} from "../../shared/timer";

/** The `timer` background kind of this backend. */
export const timersBackgroundKind = defineBackgroundKind({
  kind: "timer",
  order: 20,
  label: "Timers",
  // Timer state is the in-process registry, never Postgres.
  tables: [],
  list: () => Promise.resolve(listTimerEntries()),
  recentRuns: timerRecentRuns,
});

export interface ServerTimerSpec extends TimerSpec {
  /** Runs only on the main backend (its `start()` throws anywhere else). */
  mainOnly?: boolean;
}

/**
 * Declare an in-process interval on a worktree backend. The ONE sanctioned
 * interval (raw `setInterval` is a lint error in server/central code), and not
 * a polling escape hatch: work on a schedule is a `defineJob`, work on a
 * change is a watcher / LISTEN / event. A timer is for what must stay OUT of
 * the job queue — the queue's own watchdogs, samplers of this process — and each
 * call site is listed, with its reason, in this plugin's lint allowlist.
 *
 * Every tick is a `timer:<name>` span, recorded in memory (last run, failures,
 * a recent ring) and listed under Timers in Debug → Background activity. A
 * throwing tick is recorded as failed and rethrown as an unhandled rejection,
 * which the reports plugin files.
 *
 * ```ts
 * export const sweeperTimer = defineTimer({
 *   name: "jobs.stuck-lock-sweep", description: "Releases …", everyMs: 60_000,
 *   run: () => sweepOnce(),
 * });
 * // register: [sweeperTimer]; onReady: () => sweeperTimer.start()
 * ```
 */
export function defineTimer(spec: ServerTimerSpec): Timer & Registration {
  return defineTimerIn(spec, {
    scope: spec.mainOnly === true ? "main" : "every-worktree",
    get runsHere() {
      return spec.mainOnly !== true || isMain();
    },
    declaredIn: registeringPlugin,
    onFailure: (_name, err) => {
      throw err;
    },
    changed: (name) => timersBackgroundKind.changed(name),
  });
}
