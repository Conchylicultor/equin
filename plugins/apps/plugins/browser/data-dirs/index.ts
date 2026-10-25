import { defineAppDataDir } from "@plugins/infra/plugins/paths/core";
import { browserApp } from "@plugins/apps/plugins/browser/plugins/shell/core";

/**
 * The Browser app's one data dir, `apps/browser`. The engine keeps the
 * streamed Chromium's persistent profile here (`browserDir.subdir("profile")`):
 * cookies, logins and site storage — the only copy, so it is durable app data
 * rather than a cache.
 *
 * `shell/core` must never import this file: it reads `browserApp` from there,
 * so the reverse edge would close a cycle.
 */
export const browserDir = defineAppDataDir(browserApp, {
  owner: "apps/browser",
  description:
    "Browser app files that are the only copy: the streamed Chromium's persistent profile (cookies, logins, site storage)",
});

export default [browserDir];
