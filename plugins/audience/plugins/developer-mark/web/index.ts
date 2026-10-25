import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  DeveloperBadge,
  DeveloperCorner,
  DeveloperMark,
} from "./components/developer-mark";
export { ForAudience, type AudienceMark } from "./components/for-audience";

export default {
  description:
    "The developer-only gate and mark: ForAudience (renders its children only for the audience a feature declares, and draws the developer mark on what it shows a developer only, in the form its required `mark` names — badge, label, corner, inline — so nothing is developer-only and unmarked), DeveloperMark (the developer symbol in the primary tint, inline beside a title or opaque on a corner), DeveloperCorner (the mark overhanging a tile's corner) and DeveloperBadge (the bare symbol on a small control's corner, an action-bar button). Every surface showing something only a developer sees — a developer action, app tile, notification or toast — draws the mark, so one symbol means developer everywhere.",
  contributions: [],
} satisfies PluginDefinition;
