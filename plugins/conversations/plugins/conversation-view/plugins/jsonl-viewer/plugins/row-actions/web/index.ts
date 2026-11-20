import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlRowActions as JsonlRowActionsSlots } from "./slots";

export { JsonlRowActions } from "./slots";
export type { RowActionContribution } from "./slots";
export {
  EventActionProvider,
  EventRowActions,
} from "./internal/event-action-context";
export {
  RowActionButton,
  rowActionClass,
} from "./components/row-action-button";
export { CopyTextAction } from "./components/copy-button";

export default {
  description:
    "Owns WHICH actions a JSONL transcript row carries: the JsonlRowActions.Item slot, the per-event context, and the shared action-button styling. The cluster itself (reveal, guards, popup-hold) is primitives/row-actions, which EventRowActions wraps. Sits below collapsible-card so card chrome can host the strip without a cycle.",
  contributions: [],
  slots: JsonlRowActionsSlots,
} satisfies PluginDefinition;
