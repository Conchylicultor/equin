import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import {
  claudeCodeBlockMessage,
  claudeCodeStatus,
  type ClaudeCodeStatus,
} from "../../core";
import { claudeCodeVerdict } from "./claude-code-health";

/**
 * Claude Code's live status on this backend — loading until the first check
 * lands; `unavailable` under a host without the computer.
 */
export function useClaudeCodeStatus() {
  return useLive(claudeCodeStatus);
}

/** The health report's Claude Code row. One subscription to a pushed scalar. */
export function useClaudeCodeHealth(): HealthStatus {
  return claudeCodeVerdict(useClaudeCodeStatus());
}

/**
 * Why a launch control should be disabled, or `null` to leave it enabled.
 *
 * Only a KNOWN block disables: while the status is loading, or the check
 * itself could not answer, the control stays enabled and the server — which
 * asks again before starting anything — is the authority. So a launch is never
 * refused on a guess, and never lets a known-dead agent start either. Under a
 * host without the computer the status is `unavailable`, which is no block of
 * Claude Code's: there is no agent to start there, and the launch controls are
 * already gated on the launch endpoint's own availability.
 */
export function useClaudeCodeLaunchBlock(): string | null {
  return foldResource(useClaudeCodeStatus(), {
    loading: () => null,
    error: () => null,
    unavailable: () => null,
    ready: launchBlock,
  });
}

function launchBlock(s: ClaudeCodeStatus): string | null {
  return s.kind === "missing" || s.kind === "signed-out"
    ? claudeCodeBlockMessage(s)
    : null;
}
