import { pageInput } from "@plugins/framework/plugins/browser-server/core";
import {
  mapsBrowserConfig,
  MapsBrowserConfigValueSchema,
} from "@plugins/integrations/plugins/google-maps/core";
import type { MapsBrowserConfigSourceImpl } from "@plugins/integrations/plugins/google-maps/server";

// The page's own browser config, handed over by the page's chrome
// (`google-maps/web`'s `HostInputs.Supply`). Kept in memory by the host,
// never in its storage — so never in a build-time snapshot.
const fromPage = pageInput(mapsBrowserConfig.key);

/** The browser config of a browser host: the page's, or `unset` when its page supplies none. */
export const pageBrowserConfig: MapsBrowserConfigSourceImpl = {
  async read() {
    const input = await fromPage.read();
    return input.kind === "absent"
      ? { kind: "unset" }
      : MapsBrowserConfigValueSchema.parse(input.value);
  },
  watch: (changed) => Promise.resolve(fromPage.watch(changed)),
};
