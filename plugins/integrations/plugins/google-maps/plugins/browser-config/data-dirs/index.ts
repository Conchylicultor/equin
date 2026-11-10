import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The host-global Google Maps config: `browser-config.json`, the public browser
 * key (Maps JavaScript API) the live map renders with.
 *
 * Host-global rather than per namespace because the key is a property of the
 * user's Google Cloud project, not of a checkout: main and every agent worktree
 * read the same file, exactly as they all read the one Places key from the
 * secrets store. See this plugin's CLAUDE.md for why it is not a secret, not
 * config_v2 and not central.
 */
export const googleMapsDir = defineDataDir({
  kind: "state",
  name: "google-maps",
  owner: "integrations/google-maps/browser-config",
  description:
    "browser-config.json — the public Maps JavaScript API browser key the live map renders with, shared by every checkout",
  // The key was pasted by the user from their Google Cloud console and exists
  // nowhere else on this machine; deleting it silently turns every live map back
  // into a "set up Maps" prompt until they find it again.
  reclaim: {
    kind: "never",
    reason:
      "holds the browser key the user pasted by hand; nothing re-derives it",
  },
});

export default [googleMapsDir];
