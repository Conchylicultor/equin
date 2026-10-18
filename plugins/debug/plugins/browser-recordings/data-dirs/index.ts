import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Every recorded browser drive — an e2e run, or one `browser_*` MCP call:
 * `<toolUseId | "manual">/<runId>/` holding the `manifest.json` the
 * conversation view reads and each step's full-resolution frame
 * (`frames/<sha1>.jpg` from an e2e run, `.png` from a browser_* call; a picture shared by consecutive steps stored once).
 *
 * Host-global, keyed by the tool call that drove the browser: a tool-use id is
 * unique across sessions, and the conversation view that shows a recording
 * already names the call, not the worktree.
 */
export const browserRecordingsDir = defineDataDir({
  kind: "logs",
  name: "browser-recordings",
  owner: "debug/browser-recordings",
  description:
    "Headless browser recordings (a full-resolution frame per step and a per-run manifest) of e2e runs and browser_* MCP calls, keyed by the tool call that drove the browser",
  // Observability output: losing it blanks past filmstrips, never anything a
  // future run needs. The writer also keeps only the newest runs.
  reclaim: { kind: "safe" },
});

export default [browserRecordingsDir];
