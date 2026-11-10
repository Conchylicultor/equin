import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { readDeploySecret } from "@plugins/apps/plugins/deploy/plugins/deploy-secrets/server";
import { googleMapsDir } from "../../data-dirs";
import { GOOGLE_MAPS_BROWSER_KEY } from "@plugins/integrations/plugins/google-maps/plugins/browser-config/plugins/deployed-key/core";
import {
  BROWSER_KEY_PATTERN,
  clearMapsBrowserConfig,
  clearMapsMapId,
  setMapsBrowserConfig,
  setMapsMapId,
} from "../../core";
import {
  mapsBrowserConfigServed,
  type MapsBrowserConfigSourceImpl,
} from "../../server";
import {
  BROWSER_CONFIG_FILENAME,
  clearBrowserConfig,
  clearMapId,
  NoBrowserKeyError,
  readBrowserConfig,
  writeBrowserKey,
  writeMapId,
} from "./browser-config-store";

/** Open only while a tab is subscribed to the browser config (see below). */
export const mapsBrowserConfigWatcher = defineFileWatcher({
  name: "google-maps.browser-config",
  description:
    "While a tab shows the Google Maps settings or a map, watches the shared browser-config file so a key saved from another checkout appears at once.",
  // The one known file, followed on kqueue: heard in milliseconds, where an
  // FSEvents watch of its folder was 3–14 s late while fseventsd was loaded.
  writesWhileOpen: true,
});

/**
 * The computer's browser config. A deployed box answers its approved
 * `GOOGLE_MAPS_BROWSER_KEY` deploy secret (its own key, restricted to the
 * site's domains; no Map ID, so the raster map) — fixed for the process's
 * life, since a changed credential restarts the service. Everywhere else
 * (no such credential) it is the one host-global file: a write through any
 * checkout's endpoint notifies that backend directly; every other backend
 * learns of it from its own watcher on the directory while a tab reads it.
 */
export const browserConfigFile: MapsBrowserConfigSourceImpl = {
  async read() {
    const deployed = await readDeploySecret(GOOGLE_MAPS_BROWSER_KEY);
    if (deployed.kind === "set") {
      const browserKey = deployed.value.trim();
      // A credential that is not a key is a broken deploy, not "no map".
      if (!BROWSER_KEY_PATTERN.test(browserKey)) {
        throw new Error(
          `The ${GOOGLE_MAPS_BROWSER_KEY.key} deploy secret is not a Google API key (expected AIza…).`,
        );
      }
      return { kind: "set", browserKey, mapId: null };
    }
    return readBrowserConfig();
  },
  async watch(changed) {
    // Following a file in a missing directory fails; creating it is free.
    // The staging sibling a write renames from is not followed.
    await googleMapsDir.ensure();
    const watcher = await mapsBrowserConfigWatcher.start({
      files: [googleMapsDir.file(BROWSER_CONFIG_FILENAME)],
      onChange: () => changed(),
    });
    // The stop hook is synchronous; unsubscribing finishes on its own, tracked
    // so its cost lands in a span, and a failure still surfaces as a rejection.
    return () => {
      void runTracked("google-maps:browser-config-watcher-stop", () =>
        watcher.stop(),
      );
    };
  },
};

/**
 * A box drawing with its deploy secret has no key to set here: a write to the
 * file would be shadowed by the secret, so it is refused rather than lost.
 */
async function refuseOnDeployedKey(): Promise<void> {
  if ((await readDeploySecret(GOOGLE_MAPS_BROWSER_KEY)).kind === "set") {
    throw new HttpError(
      409,
      `This deployment draws its maps with its ${GOOGLE_MAPS_BROWSER_KEY.key} deploy secret; change the key in the Deploy app's Secrets.`,
    );
  }
}

export const handleSetBrowserConfig = implementMachine(
  setMapsBrowserConfig,
  async ({ body }) => {
    await refuseOnDeployedKey();
    await writeBrowserKey(body.browserKey);
    mapsBrowserConfigServed.notify();
  },
);

export const handleSetMapId = implementMachine(
  setMapsMapId,
  async ({ body }) => {
    await refuseOnDeployedKey();
    try {
      await writeMapId(body.mapId);
    } catch (err) {
      if (err instanceof NoBrowserKeyError)
        throw new HttpError(409, err.message);
      throw err;
    }
    mapsBrowserConfigServed.notify();
  },
);

export const handleClearMapId = implementMachine(clearMapsMapId, async () => {
  await refuseOnDeployedKey();
  await clearMapId();
  mapsBrowserConfigServed.notify();
});

export const handleClearBrowserConfig = implementMachine(
  clearMapsBrowserConfig,
  async () => {
    await refuseOnDeployedKey();
    await clearBrowserConfig();
    mapsBrowserConfigServed.notify();
  },
);
