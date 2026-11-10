import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import { serveValue } from "@plugins/network/plugins/live/server";
import { mapsBrowserConfig, type MapsBrowserConfigValue } from "../../core";

/**
 * Where this host's public Maps browser config comes from. On the computer
 * (`machine/`): a deployed box's approved `GOOGLE_MAPS_BROWSER_KEY` deploy
 * secret, else the host-global file every checkout shares, watched for another
 * checkout's write. On a browser host: what the page around the host hands it
 * (`google-maps/page-config`) — the key the page's own server already sends
 * it, never read from a server by the host's own code.
 */
export interface MapsBrowserConfigSourceImpl {
  read(): Promise<MapsBrowserConfigValue>;
  /**
   * Call `changed` whenever the config may have moved, while someone reads
   * it; returns the stop.
   */
  watch(changed: () => void): Promise<() => void>;
}

export const MapsBrowserConfigSource =
  defineHostService<MapsBrowserConfigSourceImpl>("google-maps.browser-config");

// Served on every host from its source. A write through this backend's own
// endpoint notifies directly (`machine/`); any other change reaches readers
// through the source's watch — push, never a poll. The watch lives only while
// a tab is subscribed, so an idle host holds none.
export const mapsBrowserConfigServed = serveValue(mapsBrowserConfig, {
  source: "external",
  changes: "notified",
  loader: () => MapsBrowserConfigSource.get().read(),
  whileSubscribed: async (_params, notify) =>
    MapsBrowserConfigSource.get().watch(notify),
});
