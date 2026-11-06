import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { mapsBrowserConfigServed } from "./internal/browser-config-source";

export {
  MapsBrowserConfigSource,
  mapsBrowserConfigServed,
  type MapsBrowserConfigSourceImpl,
} from "./internal/browser-config-source";

export default {
  description:
    "Google Maps Platform access broker (server, portable): serves the public browser config (the Maps JavaScript API key and the vector map's Map ID) as the google-maps.browser-config live value, read from the host's MapsBrowserConfigSource — the host-global file on the computer, the page's own config on a browser host.",
  contributions: [...mapsBrowserConfigServed.declare],
} satisfies ServerPluginDefinition;
