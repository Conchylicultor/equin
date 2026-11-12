import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import {
  evaluateHostIdleJob,
  idleWakeJob,
  requestIdleEvaluation,
} from "./internal/evaluate";
import { hostIdleServed } from "./internal/served";
import { _hostIdleState } from "./internal/tables";
import { hostIdleBegan, hostIdleEnded } from "./internal/tables-events";

export { IdleBlocker } from "./internal/registry";
export type { IdleBlockerEntry } from "./internal/registry";
export { readHostIdleRecord, requestIdleEvaluation } from "./internal/evaluate";
export { _hostIdleState } from "./internal/tables";
export {
  _hostIdleBeganTriggers,
  _hostIdleEndedTriggers,
  hostIdleBegan,
  hostIdleEnded,
} from "./internal/tables-events";

export default {
  description:
    "The host idle signal: the IdleBlocker contribution (a plugin's read() — busy or not, in words, and when to look again without an event), main's host-idle.evaluate job folding every blocker into host_idle_state (busy → settling → idle after 10 quiet minutes, nextIdleState) with host-idle.wake as its one timer, the host.idleBegan / host.idleEnded events it emits on transitions, and the hostIdle value (refused main-only elsewhere).",
  register: [evaluateHostIdleJob, idleWakeJob, hostIdleBegan, hostIdleEnded],
  contributions: [
    ...hostIdleServed.declare,
    ExcludeFromFork({
      table: _hostIdleState,
      reason:
        "The host's idle state as main's evaluation last wrote it; a fork's copy is never evaluated again, and would tell the fork's idle-time work that the host is idle long after it stopped being.",
    }),
  ],
  // A restart of main loses no state (the row) but may have missed changes:
  // evaluate once. A no-op off the host singleton.
  onReady: requestIdleEvaluation,
} satisfies ServerPluginDefinition;
