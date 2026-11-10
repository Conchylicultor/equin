import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HostInputs } from "@plugins/framework/plugins/browser-server/web";
import { mapsBrowserConfig } from "../core";

export {
  useMapsBrowserConfig,
  type MapsBrowserConfigState,
} from "./internal/use-maps-browser-config";

export default {
  description:
    "The Maps browser config, read (useMapsBrowserConfig: loading / error / unset / set { browserKey, mapId }) and handed to a browser host as a page input (HostInputs.Supply): a page rendering the demo — main's /demo or the public website — gives it the key its own server serves, so the demo's map draws without the demo ever reaching that server. Light on purpose (no auth), so the website carries it.",
  contributions: [
    // The live map's browser key is public config this page already reads:
    // a browser host rendered on the page (the demo) draws its map with it,
    // handed over by the page — its own code never reads the page's server.
    HostInputs.Supply({ value: mapsBrowserConfig }),
  ],
} satisfies PluginDefinition;
