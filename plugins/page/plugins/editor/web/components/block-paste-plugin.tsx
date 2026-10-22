import { useEffect } from "react";
import { COMMAND_PRIORITY_NORMAL, PASTE_COMMAND } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { plainOf } from "../../core";
import type { BlockTextPluginProps } from "../internal/block-text-extensions";
import { resolvePastedBlock } from "../internal/block-paste-handlers";
import { liveRunsOf } from "../internal/live-runs";
import { useBlockDocs } from "../internal/use-block-docs";

/**
 * Invisible Lexical plugin that turns a pasted file into an attachment block.
 * On `PASTE_COMMAND`, if the clipboard carries a file matching a registered
 * block-paste handler, we `preventDefault`, upload it, and either convert an
 * empty block in place or insert a new block after a non-empty one. Files that
 * match no handler fall through (return false), so url-paste / the default
 * RichText paste still run. Registered at `COMMAND_PRIORITY_NORMAL` so it beats
 * the default RichText paste (LOW) for files.
 */
export function BlockPastePlugin({ block, editor }: BlockTextPluginProps) {
  const [lexical] = useLexicalComposerContext();
  const fetchEndpoint = useFetchEndpoint();
  const docs = useBlockDocs();
  useEffect(() => {
    return lexical.registerCommand<ClipboardEvent>(
      PASTE_COMMAND,
      (event) => {
        const picked = resolvePastedBlock(event.clipboardData);
        if (!picked) return false; // not a pasted file → let url-paste / default run
        event.preventDefault();
        const { file, handler } = picked;
        const empty = plainOf(liveRunsOf(docs, block)).trim() === "";
        void (async () => {
          const data = await handler.build(file, { fetchEndpoint });
          // Empty block → convert it in place; otherwise insert a new block after.
          if (empty) editor.convertTo(handler.type, data);
          else editor.insertAfter(handler.type, data);
        })();
        return true;
      },
      COMMAND_PRIORITY_NORMAL, // beats the default RichText paste (LOW) for files
    );
  }, [lexical, block, editor, fetchEndpoint, docs]);
  return null;
}
