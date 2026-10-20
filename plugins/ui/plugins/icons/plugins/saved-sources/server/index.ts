import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  defineSavedIconSource,
  savedIconSources,
} from "./internal/saved-sources";
export type { SavedIconSource } from "./internal/saved-sources";

export default {
  description:
    "The saved-icon source registry: defineSavedIconSource registers a place that stores user-picked icons (its tables, its names, a watch for a non-DB store), and savedIconSources lists them for the sprites plugin's resident icons.saved-sprites value. Pure and portable, so a plugin whose server half runs in the browser host can register its source without reaching the sprites builder.",
  portable: true,
} satisfies ServerPluginDefinition;
