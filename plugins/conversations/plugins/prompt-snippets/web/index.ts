import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { SnippetEditor } from "./components/snippet-editor";
export type {
  SnippetDraft,
  SnippetEditorProps,
} from "./components/snippet-editor";
export { useSnippetListEdit } from "./internal/use-snippet-list-edit";
export type {
  Snippet,
  SnippetEditing,
  SnippetListEdit,
  SnippetListEditOptions,
  OpenSnippetEditor,
} from "./internal/use-snippet-list-edit";

export default {
  description:
    "Named prompt snippets ({ title, prompt }) edited in place inside the popup that lists them: SnippetEditor (a name and a prompt, Add / Save / Delete / Cancel, holding its popup open) and useSnippetListEdit (which editor is open, and the list rewritten from what it hands back). Shared by the prompt templates panel and the preprompt picker.",
  contributions: [],
} satisfies PluginDefinition;
