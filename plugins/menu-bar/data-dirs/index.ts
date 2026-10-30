import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Legacy: the native helper's stable copy the server's shim sync used to make.
 * Nothing writes it any more — the helper installs apps itself, from its own
 * executable (`rust/src/apps.rs`) — but Linux desktop entries written before
 * that still name the binary here until the helper's first sync rewrites them.
 */
export const menuBarState = defineDataDir({
  kind: "state",
  name: "menu-bar",
  owner: "menu-bar",
  description:
    "Legacy: the native helper copy installed-app shims ran before the helper installed apps itself; nothing writes it",
  reclaim: {
    kind: "never",
    reason:
      "Linux desktop entries written before the helper installed apps itself run the helper by this path until its first sync rewrites them",
  },
});

/** Where the helper's stdout and stderr land when it runs as a login service. */
export const menuBarLogs = defineDataDir({
  kind: "logs",
  name: "menu-bar",
  owner: "menu-bar",
  description:
    "The native menu-bar helper's stdio capture, when it runs as the dev.equin.menu-bar login service",
  reclaim: { kind: "safe" },
});

export default [menuBarState, menuBarLogs];
