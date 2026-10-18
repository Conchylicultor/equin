import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import {
  ForkFromMessageAction,
  RewindAction,
} from "./components/rewind-action";

export { useGoBackToMessage } from "./hooks/use-go-back";
export type { RewindMode } from "./hooks/use-go-back";

export default {
  description:
    "Row actions on each of the user's own messages: go back to just before it, in this conversation (Rewind to here) or in a new one (Fork from here). Warns first about what cannot be brought back. useGoBackToMessage is the same flow for a surface that stands for a hidden message (e.g. a question's answer), with the caller deciding where the removed text goes.",
  contributions: [
    JsonlRowActions.Item({ id: "rewind", component: RewindAction }),
    JsonlRowActions.Item({
      id: "fork-from-message",
      component: ForkFromMessageAction,
    }),
  ],
} satisfies PluginDefinition;
