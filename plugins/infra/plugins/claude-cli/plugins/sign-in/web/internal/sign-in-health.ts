import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { ClaudeSignInFlow } from "../../core";

/**
 * The Claude Code row's verdict while the computer signs in. Only a KNOWN
 * signed-out row (`critical`) changes: a sign-in under way is `attention`,
 * pulsing ("Signing in…"); one that failed stays `critical` and says so.
 * Anything else — loading, unreadable, ready, a new account's sign-in — is the
 * row's own verdict.
 */
export function signInHealth(
  cli: HealthStatus,
  flow: ClaudeSignInFlow | null,
): HealthStatus {
  if (cli.state !== "critical" || flow === null) return cli;
  if (flow.kind === "idle" || flow.target.kind !== "computer") return cli;
  switch (flow.kind) {
    case "waiting":
      return {
        state: "attention",
        summary: "Signing in…",
        transitioning: true,
      };
    case "failed":
      return {
        state: "critical",
        summary: "Sign-in didn't finish — agents can't start",
      };
    case "done":
      // The re-check that follows a finished sign-in is the row's to report.
      return cli;
  }
}
