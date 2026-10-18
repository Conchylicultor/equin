import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { CopySourceTextHost } from "./components/copy-source-text-host";

export { installCopySourceText } from "./internal/install-copy-source-text";
export {
  COPY_SOURCE_ATTR,
  copiesAsOwnText,
  copiesAsText,
} from "./internal/attr";
export type { CopySourceProps } from "./internal/attr";

export default {
  description:
    "Copy what an element STANDS FOR, not only what it shows: an element declares its source text via copiesAsText() / copiesAsOwnText — exported beside the handler, so importing them ships it — and one Core.Root-mounted document copy handler swaps every declaring element in the selection for that text before re-serializing the clipboard through the browser's own block-aware serializer. Restores the characters a rendering replaced (an active-data chip's `token`), and removes the newlines a chip's blockified label box injects mid-sentence. Yields to any handler that already prevented the default, and never acts inside a contenteditable. A substituting element also SELECTS as one unit: its letters take no highlight, and a selectionchange listener rings the whole element while the selection overlaps it — so the selection shows exactly what the copy will carry.",
  contributions: [Core.Root({ component: CopySourceTextHost })],
} satisfies PluginDefinition;
