import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * `equin.app` — the macOS app bundle every login service runs from (the
 * gateway, the menu-bar helper), assembled from their builds and signed with
 * the machine's identity, so macOS names every permission after one app,
 * "equin". At a stable path, outside the per-build deps cache: LaunchServices
 * and System Settings want one app, and each service rebuilds on its own.
 * Never under a temporary directory: LaunchServices disables a bundle there.
 */
export const macosAppDir = defineDataDir({
  kind: "state",
  name: "macos-app",
  owner: "infra/launcher/login-services",
  description:
    "equin.app — the app bundle the login services (gateway, menu-bar helper) run from on macOS",
  // The running services' executables live here; the next `./equin start`
  // re-assembles it from the deps cache.
  reclaim: { kind: "restart" },
});

export default [macosAppDir];
