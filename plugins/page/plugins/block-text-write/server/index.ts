import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

// The one server-side text channel: every writer that sets a block's text with
// no mounted editor (markdown apply, history restore) goes through this, after
// its structural write has committed.
export { writeBlockTexts } from "./internal/write-block-texts";
export type { BlockTextEdit } from "./internal/write-block-texts";

export default {
  description:
    "Server-side text writes for a block's content doc — read a stored doc's true runs, splice it to target runs (or seed it first-writer-wins), then write the row's data.text projection: the one text channel every server-side content writer goes through.",
} satisfies ServerPluginDefinition;
