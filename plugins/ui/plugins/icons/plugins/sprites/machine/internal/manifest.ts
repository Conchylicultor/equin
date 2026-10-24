import { serveValue } from "@plugins/network/plugins/live/machine";
import { iconManifest } from "../../core";
import { ICON_MANIFEST } from "./icon-manifest.generated";

/**
 * The manifest's symbol names. External and `fixed`: the manifest is compiled
 * into this process, so the first load is the only one.
 */
export const iconManifestServed = serveValue(iconManifest, {
  source: "external",
  changes: {
    fixed: { reason: "the icon manifest compiled into this process" },
  },
  loader: () => Promise.resolve({ symbols: [...ICON_MANIFEST.symbols] }),
});
