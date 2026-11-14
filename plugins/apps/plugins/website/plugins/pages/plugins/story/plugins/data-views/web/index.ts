import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { ClaudeAfter, ClaudeBefore, NotionDataView } from "./figures";

export default {
  description:
    "The story's data-view figures, pictures drawn on invented data (never live collections): <NotionDataView> (a Notion-like reading list on the same data view as the Artifacts page — views, search, filter, sort, layout, group by, infinite scroll), <ClaudeBefore> (the Claude app's sidebar and Artifacts page, cloned from claude.ai's light theme, two partial reimplementations of a data view) and <ClaudeAfter> (the same two surfaces rebuilt on one data-view primitive). Under the Claude figures, one feature line per capability; hovering one opens that capability in both surfaces at once, boxed by one highlight per surface, lists scrolling it into view and back, menu trees that never move once open.",
  contributions: [],
} satisfies PluginDefinition;
