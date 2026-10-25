import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Browser } from "@plugins/apps/plugins/browser/plugins/shell/web";
import { Omnibox } from "./components/omnibox";

export { normalizeInput, type NormalizedInput } from "./normalize";
export { FOCUS_ADDRESS_KEYS } from "./focus-keys";

export default {
  description:
    "Browser address bar: URL normalization with search fallback, synced to the current URL.",
  contributions: [Browser.Omnibox({ id: "omnibox", component: Omnibox })],
} satisfies PluginDefinition;
