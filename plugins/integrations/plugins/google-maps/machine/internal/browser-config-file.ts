import { basename } from "node:path";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { googleMapsDir } from "../../data-dirs";
import {
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
});

/**
 * The computer's browser config: the one host-global file. A write through
 * any checkout's endpoint notifies that backend directly; every other backend
 * learns of it from its own watcher on the directory while a tab reads it.
 */
export const browserConfigFile: MapsBrowserConfigSourceImpl = {
  read: () => readBrowserConfig(),
  async watch(changed) {
    // Subscribing to a missing directory fails; creating it is free.
    const dir = googleMapsDir.ensure();
    const watcher = await mapsBrowserConfigWatcher.start({
      dirs: [dir],
      onChange: (events) => {
        // The staging sibling a write renames from shares the directory; only
        // the target file's own events mean the value moved.
        if (events.some((e) => basename(e.path) === BROWSER_CONFIG_FILENAME)) {
          changed();
        }
      },
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

export const handleSetBrowserConfig = implementMachine(
  setMapsBrowserConfig,
  async ({ body }) => {
    await writeBrowserKey(body.browserKey);
    mapsBrowserConfigServed.notify();
  },
);

export const handleSetMapId = implementMachine(
  setMapsMapId,
  async ({ body }) => {
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
  await clearMapId();
  mapsBrowserConfigServed.notify();
});

export const handleClearBrowserConfig = implementMachine(
  clearMapsBrowserConfig,
  async () => {
    await clearBrowserConfig();
    mapsBrowserConfigServed.notify();
  },
);
