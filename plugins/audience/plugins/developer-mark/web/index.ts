import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { DeveloperCorner, DeveloperMark } from "./components/developer-mark";

export default {
  description:
    "The developer-only mark: DeveloperMark (the developer symbol in the primary tint, inline beside a title or opaque on a corner) and DeveloperCorner (the mark overhanging a tile's corner). Every surface showing something only a developer sees — a developer app's tile, a developer notification or toast — draws it, so one symbol means developer everywhere.",
  contributions: [],
} satisfies PluginDefinition;
