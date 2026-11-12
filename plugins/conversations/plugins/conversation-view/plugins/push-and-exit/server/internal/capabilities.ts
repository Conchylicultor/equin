import { Mandate } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
  EXIT_WHEN_TEXT,
  exitClean,
  flagRaise,
  MANDATE_PUSH_POLICY_TEXT,
  pushPolicy,
} from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/capabilities/core";

/**
 * How each push-and-exit grant reads to the agent. The defaults say nothing:
 * pushing only when asked is CLAUDE.md's rule, and `exit_clean`'s own
 * description says it closes on request. A line only for a policy that
 * differs — the Mandate is the only channel for a push or a close on the
 * agent's own initiative (pushing is a CLI command, no tool describes it).
 */
export const pushAndExitCapabilities = [
  Mandate.Capability({
    cap: pushPolicy,
    describe: (policy) =>
      policy === "on-request"
        ? null
        : `Pushing: ${MANDATE_PUSH_POLICY_TEXT[policy]}`,
  }),
  Mandate.Capability({
    cap: exitClean,
    describe: (when) => (when === "on-request" ? null : EXIT_WHEN_TEXT[when]),
  }),
  Mandate.Capability({
    cap: flagRaise,
    describe: () => null,
  }),
];
