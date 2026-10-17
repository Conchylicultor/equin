import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  WithHoverCard,
  type HoverCardChip,
  type HoverCardContent,
  type HoverCardList,
  type HoverCardSteps,
  type WithHoverCardProps,
} from "./internal/with-hover-card";

export default {
  description:
    "Hover card: <WithHoverCard card> describes its trigger in a card drawn as the shared overlay panel (the menu's look, one fixed width) — a title with an inline code id, a description, has / lacks chips, a path of steps, headed lists, a notice and a mono footer, passed as DATA so no call site styles its own card. Placed beside the trigger, or beside the menu the trigger is a row of, level with that row.",
  contributions: [],
} satisfies PluginDefinition;
