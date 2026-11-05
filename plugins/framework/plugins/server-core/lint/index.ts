import noProcessCrashListener from "./no-process-crash-listener";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "server-core",
  rules: {
    // The process's crash listeners are the framework's (processCrashSink).
    "no-process-crash-listener": noProcessCrashListener,
  },
  // A test swaps listeners to observe what its subject rejects; an e2e or a
  // script is its own process, never booted through the plugin graph.
  outOfScope: {
    "no-process-crash-listener": ["test", "e2e", "script", "research"],
  },
} satisfies LintContribution;
