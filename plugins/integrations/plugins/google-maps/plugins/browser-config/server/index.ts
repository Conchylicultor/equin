import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { mapsBrowserConfigServed } from "./internal/browser-config-source";

export {
  MapsBrowserConfigSource,
  mapsBrowserConfigServed,
  type MapsBrowserConfigSourceImpl,
} from "./internal/browser-config-source";

export default {
  description:
    "The Maps browser config, served (portable): the google-maps.browser-config live value (the Maps JavaScript API key and the vector map's Map ID), read from the host's MapsBrowserConfigSource — the deploy secret or the host-global file on the computer, the page's own config on a browser host.",
  contributions: [...mapsBrowserConfigServed.declare],
} satisfies ServerPluginDefinition;
