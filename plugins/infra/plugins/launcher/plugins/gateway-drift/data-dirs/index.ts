import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Main's follow-main restart of the machine's gateway (`gateway-drift/cli`):
 * `follow.lock` (one follow at a time, machine-wide — the run that restarted
 * the gateway and the successor's boot-edge run must not both act) and
 * `last-attempt.json` (the launch last tried, so a launch is tried once:
 * the termination rule of the loop a failing gateway would otherwise start —
 * every gateway boot runs the converge, which would retry it).
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

export default [gatewayFollowState];
