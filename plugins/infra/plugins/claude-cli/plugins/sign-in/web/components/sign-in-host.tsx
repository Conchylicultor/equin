import { useEffect } from "react";
import { openInBrowserTab } from "@plugins/primitives/plugins/link-gesture/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import type { ClaudeSignInFlow } from "../../core";
import {
  claimAnnouncement,
  claimOpen,
  wasStartedHere,
} from "../internal/started-here";
import { useClaudeSignInFlow } from "../internal/use-sign-in";

function doneMessage(
  flow: Extract<ClaudeSignInFlow, { kind: "done" }>,
): string {
  return flow.target.kind === "computer"
    ? "Signed in — agents can start"
    : `Added ${flow.target.name}`;
}

/**
 * Mounted at the app root, so a run's page opens and its outcome is announced
 * wherever its panel is (or is not) drawn — for a run THIS page started: open
 * its sign-in page once, announce it once. One small pushed value.
 */
export function ClaudeSignInHost() {
  const result = useClaudeSignInFlow();
  const flow = result.status === "ready" ? result.data : null;
  useEffect(() => {
    if (!flow || flow.kind === "idle" || !wasStartedHere(flow.id)) return;
    // The page Claude Code asked to open, in this browser: the click that
    // started the run is a few hundred milliseconds old, so the browser lets
    // it open a tab. If it blocks it, "Open the page again" is right there.
    if (flow.kind === "waiting" && flow.url && claimOpen(flow.id))
      openInBrowserTab(flow.url);
    if (flow.kind === "done" && claimAnnouncement(flow.id))
      showToast({ variant: "success", description: doneMessage(flow) });
  }, [flow]);
  return null;
}
