import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The native helper's stable copy (`equin-desktop`, plus the deps identity it
 * was copied from): what every installed app shim names — the Linux
 * `.desktop` entries run it by this path, the macOS bundles hold an APFS clone
 * of it. Copied out of the deps cache so a shim never names a cache identity
 * the sweep may delete; re-copied (and every shim re-synced) when the helper's
 * identity changes.
 */
export const menuBarState = defineDataDir({
  kind: "state",
  name: "menu-bar",
  owner: "menu-bar",
  description:
    "The native menu-bar helper's stable copy, which every installed app shim (~/Applications, ~/.local/share/applications) runs",
  reclaim: {
    kind: "never",
    reason:
      "installed app shims run the helper by this path; deleting it breaks every installed app until the next install re-copies it",
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
