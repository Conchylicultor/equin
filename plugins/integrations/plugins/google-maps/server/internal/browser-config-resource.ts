import { basename } from "node:path";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { googleMapsDir } from "../../data-dirs";
import {
  clearMapsBrowserConfig,
  mapsBrowserConfig,
  setMapsBrowserConfig,
} from "../../core";
import {
  BROWSER_CONFIG_FILENAME,
  clearBrowserConfig,
  readBrowserConfig,
  writeBrowserConfig,
} from "./browser-config-store";

/** Open only while a tab is subscribed to the browser config (see below). */
export const mapsBrowserConfigWatcher = defineFileWatcher({
  name: "google-maps.browser-config",
  description:
    "While a tab shows the Google Maps settings or a map, watches the shared browser-config file so a key saved from another checkout appears at once.",
});

// Served on EVERY backend from the one host-global file. A write through any
// checkout's endpoint notifies that backend directly; every other backend learns
// of it from its own watcher on the directory — push, never a poll. The watcher
// lives only while a tab is subscribed, so an idle backend holds none.
export const mapsBrowserConfigServed = serveValue(mapsBrowserConfig, {
  source: "external",
  changes: "notified",
  loader: () => readBrowserConfig(),
  whileSubscribed: async (_params, notify) => {
    // Subscribing to a missing directory fails; creating it is free.
    const dir = googleMapsDir.ensure();
    const watcher = await mapsBrowserConfigWatcher.start({
      dirs: [dir],
      onChange: (events) => {
        // The staging sibling a write renames from shares the directory; only
        // the target file's own events mean the value moved.
        if (events.some((e) => basename(e.path) === BROWSER_CONFIG_FILENAME)) {
          notify();
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
});

export const handleSetBrowserConfig = implement(
  setMapsBrowserConfig,
  async ({ body }) => {
    await writeBrowserConfig(body);
    mapsBrowserConfigServed.notify();
  },
);

export const handleClearBrowserConfig = implement(
  clearMapsBrowserConfig,
  async () => {
    await clearBrowserConfig();
    mapsBrowserConfigServed.notify();
  },
);
