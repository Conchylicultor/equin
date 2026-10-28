import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { EventTurnRow } from "./components/event-turn-row";

export default {
  description:
    "Renders an event turn the app delivered to a watching agent (the turn ledger's <equin-event> envelope) as a compact system card — its first line in the header, the event lines and subtree digest folded below — never as a message the user wrote.",
  contributions: [
    JsonlViewer.EventRenderer({ match: "event-turn", component: EventTurnRow }),
  ],
} satisfies PluginDefinition;
