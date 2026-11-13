import { TextEditorSlots } from "./slots";
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { TextEditor } from "./components/text-editor";
export type { TextEditorProps } from "./components/text-editor-impl";
export { TextEditorSlots, type TextEditorPluginProps } from "./slots";
export {
  registerNodeExtension,
  registerNodeExtensionSource,
  type NodeExtension,
} from "./internal/node-extensions";
export { useInsertMarkdown } from "./internal/use-insert-markdown";
export { useTakeMarkdownWith } from "./internal/use-take-markdown-with";
export { useReadMarkdown } from "./internal/use-read-markdown";

export default {
  description:
    "Generic Lexical-based rich text editor primitive. Plugins inject behaviors via the Plugin slot and registerNodeExtension.",
  contributions: [],
  slots: TextEditorSlots,
} satisfies PluginDefinition;
