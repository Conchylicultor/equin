import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportNoiseRule } from "@plugins/reports/server";

export default {
  description:
    "Built-in noise classification rules for low-signal crashes (e.g. ResizeObserver loop warnings).",
  contributions: [
    ReportNoiseRule({
      id: "resize-observer",
      matches: ({ message, errorType }) =>
        message.toLowerCase().includes("resizeobserver") ||
        (errorType?.toLowerCase().includes("resizeobserver") ?? false),
    }),
    // A one-shot `claude --print` exiting 143/137 means the subprocess was
    // killed by a signal (SIGTERM/SIGKILL) — server restart during build, or
    // our own timeout `proc.kill()`. Not a real failure, just an interrupted
    // throwaway generation. Mute so shutdowns don't spam crash tasks.
    ReportNoiseRule({
      id: "claude-cli-signal-kill",
      matches: ({ errorType, message }) =>
        errorType === "ClaudeCliError" &&
        /claude --print exited (?:143|137)\b/.test(message),
    }),
    // A crash whose originating frontend tab is running an obsolete bundle
    // (build id mismatch). Benign version-skew during a rollout, not a live bug
    // — record + file the (attributed) task, but mute its notification.
    ReportNoiseRule({
      id: "stale-frontend",
      matches: (i) => i.staleOrigin === true,
    }),
    // A live-state wedge the watchdog attributed to a server restart (its
    // discriminator ends `:restart`): missed updates while the tab was
    // backgrounded across one, or a handshake held while the server booted.
    // Benign deploy-skew, not a stuck pipeline — and the build-id check above
    // can't catch it, because such a tab is still on the build the server is
    // currently serving. Record + file the task, mute the notification.
    ReportNoiseRule({
      id: "live-state-wedge-restart",
      matches: ({ errorType }) =>
        errorType?.startsWith("LiveStateWedge:") === true &&
        errorType.endsWith(":restart"),
    }),
  ],
} satisfies ServerPluginDefinition;
