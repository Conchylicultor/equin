import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The browser-engine host's runtime files: its Unix socket (`host.sock`), pid
 * file, singleton lock and published `status.json`. One host per machine, so
 * one directory — never per namespace.
 */
export const browserEngineDir = defineDataDir({
  kind: "services",
  name: "browser-engine",
  owner: "apps/browser/engine",
  description:
    "The Browser app's engine host's socket, pid file, singleton lock and published status — the Chromium whose pages the app's tabs stream",
  // A socket and a pid mean nothing once their process is gone, and the next
  // tab the app opens relaunches the host.
  reclaim: { kind: "restart" },
});

/**
 * The engine's Chromium as launched on macOS: a copy of the installed headed
 * app bundle flagged background-only (`bin/background-app.ts`), one per
 * installed Chromium build. Derived from the install, so rebuilt on demand.
 */
export const browserEngineAppDir = defineDataDir({
  kind: "cache",
  name: "browser-engine-app",
  owner: "apps/browser/engine",
  description:
    "The Browser app engine's Chromium: a background-only copy of the installed headed Chromium app bundle (no Dock icon), one per Chromium build",
  reclaim: { kind: "safe" },
});

export default [browserEngineDir, browserEngineAppDir];
