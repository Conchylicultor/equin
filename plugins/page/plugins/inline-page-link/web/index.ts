import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import "./internal/register";

export default {
  description:
    "Inline page links: type [[ in any text block (or paste a bare block id) to drop a clickable page reference — a pasted id into an empty block turns it into a link-to-page block; stored as a [[page:<pageId>]] token and fed into the backlinks index.",
  contributions: [],
} satisfies PluginDefinition;
