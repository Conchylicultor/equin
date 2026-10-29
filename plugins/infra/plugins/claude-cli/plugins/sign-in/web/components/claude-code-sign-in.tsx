import { useCollapsibleContext } from "@plugins/primitives/plugins/collapsible/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { useClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import type { ClaudeSignInFlow } from "../../core";
import { signInHealth } from "../internal/sign-in-health";
import {
  useClaudeSignInActions,
  useClaudeSignInFlow,
} from "../internal/use-sign-in";
import { ClaudeSignInButton } from "./sign-in-button";
import { ClaudeSignInPanel, type OpenSignInFlow } from "./sign-in-flow";

// The computer's sign-in, as the health report's Claude Code row shows it: the
// Sign in split button where the row offers its fix, the run's panel at the top
// of the row's detail, and the row's verdict while it runs.

/** The computer's run still open (waiting, or failed and not dismissed). */
function openComputerFlow(flow: ClaudeSignInFlow): OpenSignInFlow | null {
  if (flow.kind !== "waiting" && flow.kind !== "failed") return null;
  return flow.target.kind === "computer" ? flow : null;
}

function useOpenComputerFlow(): OpenSignInFlow | null {
  return foldResource(useClaudeSignInFlow(), {
    loading: () => null,
    error: () => null,
    unavailable: () => null,
    ready: openComputerFlow,
  });
}

/**
 * The Claude Code row's remedy: Sign in, while the computer is known to be
 * signed out and no sign-in is under way (the row's detail shows that one —
 * signing in opens it).
 */
export function ClaudeCodeSignInRemedy() {
  const status = useClaudeCodeStatus();
  const open = useOpenComputerFlow();
  const actions = useClaudeSignInActions();
  const row = useCollapsibleContext();
  if (status.status !== "ready" || status.data.kind !== "signed-out")
    return null;
  if (open) return null;
  // A status read off this computer means its endpoints answer too.
  if (actions.kind === "unavailable")
    throw new Error("Claude sign-in: endpoints disagree on the computer");
  return (
    <ClaudeSignInButton
      onSignIn={async (method) => {
        if (row && !row.open) row.toggle();
        await actions.start({ kind: "computer", method });
      }}
    />
  );
}

/** The computer's sign-in under way (or failed), for the row's detail. */
export function ClaudeCodeSignInDetail() {
  const open = useOpenComputerFlow();
  return open ? <ClaudeSignInPanel flow={open} /> : null;
}

/**
 * The Claude Code row's verdict with the computer's sign-in folded in
 * (`signInHealth`): "Signing in…" while it runs. One pushed value, read by the
 * always-mounted health dot.
 */
export function useClaudeCodeSignInHealth(cli: HealthStatus): HealthStatus {
  const flow = foldResource(useClaudeSignInFlow(), {
    loading: () => null,
    error: () => null,
    unavailable: () => null,
    ready: (f: ClaudeSignInFlow) => f,
  });
  return signInHealth(cli, flow);
}
