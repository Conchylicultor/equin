import { pageInput } from "@plugins/framework/plugins/browser-server/core";
import {
  mapsBrowserConfig,
  MapsBrowserConfigValueSchema,
} from "@plugins/integrations/plugins/google-maps/plugins/browser-config/core";
import type { MapsBrowserConfigSourceImpl } from "@plugins/integrations/plugins/google-maps/plugins/browser-config/server";

// The page's own browser config, handed over by the page's chrome
// (`google-maps/browser-config/web`'s `HostInputs.Supply`). Kept in memory by the host,
// never in its storage — so never in a build-time snapshot.
const fromPage = pageInput(mapsBrowserConfig.key);

/**
 * The browser config of a browser host: the page's, `pending` while the page
 * has not handed it over yet, or `unset` when its page supplies none. Never
 * awaits the page (see `PageInputRead`).
 */
export const pageBrowserConfig: MapsBrowserConfigSourceImpl = {
  async read() {
    const input = fromPage.read();
    switch (input.kind) {
      case "absent":
        return { kind: "unset" };
      case "pending":
        return { kind: "pending" };
      case "failed":
        throw new Error(
          `The page could not read "${mapsBrowserConfig.key}": ${input.message}`,
        );
      case "value":
        return MapsBrowserConfigValueSchema.parse(input.value);
    }
  },
  watch: (changed) => Promise.resolve(fromPage.watch(changed)),
};
