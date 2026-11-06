import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { PLACES_CATEGORY_ID } from "../core";
import { askCandidatesServed } from "./internal/resource";

export default {
  description:
    "Ask Sonnet in the Places search bar, server half (portable): the Places task category and the conversations_ext_places_ask side-table of the Google candidates each run has seen, served lookup-only as places.ask.candidates (what a pick's card is drawn from).",
  contributions: [
    TaskCategory({ id: PLACES_CATEGORY_ID, label: "Places", order: 18 }),
    ...askCandidatesServed.declare,
  ],
} satisfies ServerPluginDefinition;
