import { useCallback } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { getNodeExtensions } from "./node-extensions";
import { $serializeRootToMarkdown } from "./markdown";

/**
 * Read the whole draft as markdown without touching it — the same
 * serialization {@link useTakeMarkdownWith} hands back, so tokens (chips,
 * images) come out as their source text.
 *
 * Must be called inside a `LexicalComposer` (the editor's own subtree).
 */
export function useReadMarkdown(): () => string {
  const [editor] = useLexicalComposerContext();
  return useCallback(
    () =>
      editor
        .getEditorState()
        .read(() => $serializeRootToMarkdown(getNodeExtensions())),
    [editor],
  );
}
