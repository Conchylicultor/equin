import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Main's follow-main restart of the machine's gateway (`gateway-drift/cli`):
 * `follow.lock` (one follow at a time, machine-wide — the run that restarted
 * the gateway and the successor's boot-edge run must not both act) and
 * `last-attempt.json` (the launch last tried, so a launch is tried once:
 * the termination rule of the loop a failing gateway would otherwise start —
 * every gateway boot runs the converge, which would retry it), and the switch
 * helper's plan and log (`switch-plan.json`, `switch.log`).
 */
export const gatewayFollowState = defineDataDir({
  kind: "state",
  name: "gateway-follow",
  owner: "infra/launcher/gateway-drift",
  description:
    "Main's follow-main gateway restart: its lock and the launch it last attempted (tried once, never retried)",
  reclaim: {
    kind: "never",
    reason:
      "the record of which gateway launch was already attempted; losing it retries a launch that failed, restarting every backend once more",
  },
});

export const FOLLOW_LOCK_FILENAME = "follow.lock";
export const LAST_ATTEMPT_FILENAME = "last-attempt.json";
/**
 * A service restart the follow hands to the switch helper (`bin/switch.ts`):
 * the plan it runs, and the log it writes — the one record of a restart the
 * run that planned it did not live to see.
 */
export const SWITCH_PLAN_FILENAME = "switch-plan.json";
export const SWITCH_LOG_FILENAME = "switch.log";

export default [gatewayFollowState];
