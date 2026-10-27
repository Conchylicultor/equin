import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useMailAttachment } from "./internal/use-mail-attachment";
export type { UseMailAttachment } from "./internal/use-mail-attachment";
export { AttachmentChip, type AttachmentChipProps } from "./components/attachment-chip";

export default {
  description:
    "Reading-pane attachment UI: the useMailAttachment() lazy-download hook (download → URL for a click, materialise → fire-and-forget for a reader of the live row; deduped, cached) and the AttachmentChip component (filename + size + MIME icon; downloads on click and opens in a new tab).",
  contributions: [],
} satisfies PluginDefinition;
