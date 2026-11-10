import { DeploySecrets } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/server";
import {
  GOOGLE_MAPS_BROWSER_KEY,
  GOOGLE_MAPS_MAP_ID,
} from "@plugins/integrations/plugins/google-maps/plugins/browser-config/plugins/deployed-key/core";
import { browserConfigFile } from "./browser-config-file";
import { readBrowserConfig } from "./browser-config-store";

/**
 * The computer's counterparts of the site's Maps deploy values: the key and
 * the Map ID in the host-global browser-config file — read from the FILE,
 * never through the source (which a box answers from the deploy secret
 * itself). Offered by the Deploy app's Secrets section as "Use this computer's
 * value", so the user need not look them up.
 */
export const mapsDeploySecretLocalValues = [
  DeploySecrets.LocalValue({
    secret: GOOGLE_MAPS_BROWSER_KEY,
    reveal: "masked",
    // The key ends up in every page of the public site: reusing this
    // computer's key is a choice, not the default.
    caution:
      "This key will be public in every page of the site. A separate key restricted to the site's domains (HTTP referrers) and to the Maps JavaScript API is advised.",
    read: async () => {
      const config = await readBrowserConfig();
      return config.kind === "set"
        ? { kind: "set", value: config.browserKey }
        : { kind: "unset" };
    },
    watch: (changed) => browserConfigFile.watch(changed),
  }),
  DeploySecrets.LocalValue({
    secret: GOOGLE_MAPS_MAP_ID,
    reveal: "plain",
    caution:
      "A Map ID draws the vector map only with a key from the same Google Cloud project — with a separate key for the site, use a Map ID of that key's project.",
    read: async () => {
      const config = await readBrowserConfig();
      return config.kind === "set" && config.mapId !== null
        ? { kind: "set", value: config.mapId }
        : { kind: "unset" };
    },
    watch: (changed) => browserConfigFile.watch(changed),
  }),
];
