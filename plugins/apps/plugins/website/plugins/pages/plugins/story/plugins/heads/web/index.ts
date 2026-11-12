import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { MindOverload } from "./components/mind-overload";
export { ReviewDesk } from "./components/review-desk";

export default {
  description:
    "The story's two head figures, drawn around one line-profile head with the same little robots: <MindOverload> (agents crowd in from every side, each pushing its conversation into the head, where the phrases jostle until an answer travels back out — the head is never clear) and <ReviewDesk> (ideas leave the head as agents working in the background, come back to wait in a line on the desk, and are reviewed one at a time — closed, or sent back to work). Each runs only while on screen; reduced motion gets a still.",
  contributions: [],
} satisfies PluginDefinition;
