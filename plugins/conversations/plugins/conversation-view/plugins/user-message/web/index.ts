import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { UserMessageCard, UserMessageText } from "./components/user-message";

export default {
  description:
    "The user turn's standard look: <UserMessageCard> (the message-card chrome) and <UserMessageText> (the turn's text through every inline-text walker, so chips render). Shared by the transcript's user-text row and the optimistic pending-turn card, so a message looks the same before and after it is confirmed.",
  contributions: [],
} satisfies PluginDefinition;
