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

/**
 * Files the user picked for a page's file input, copied here for the engine's
 * Chromium to read (`bin/host-uploads.ts`): one directory per page, removed
 * with the page, and the whole of it emptied when the host starts. A live
 * page may still read its files, so it is reclaimed only with the host down.
 */
export const browserEngineUploadsDir = defineDataDir({
  kind: "cache",
  name: "browser-engine-uploads",
  owner: "apps/browser/engine",
  description:
    "Files picked for a page's upload in the Browser app, held for the engine's Chromium to read while the page lives",
  reclaim: { kind: "restart" },
});

export default [browserEngineDir, browserEngineAppDir, browserEngineUploadsDir];
