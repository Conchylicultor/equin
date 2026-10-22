import { useEffect } from "react";
import { COMMAND_PRIORITY_NORMAL, DROP_COMMAND, PASTE_COMMAND } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { attachFiles, filesOf } from "./attach-files";

/**
 * Paste or drop files into any text editor: each is uploaded as an attachment
 * and lands at the caret (see {@link attachFiles}).
 */
export function ImageUploadPlugin({
  onError,
}: {
  onError?: (msg: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const fetchEndpoint = useFetchEndpoint();

  useEffect(() => {
    const handle = (event: ClipboardEvent | DragEvent) => {
      const isDrop = event instanceof DragEvent;
      const data = isDrop ? event.dataTransfer : event.clipboardData;
      if (!data) return false;
      const files = filesOf(data, isDrop ? "drop" : "paste");
      if (files.length === 0) return false;
      event.preventDefault();
      attachFiles(fetchEndpoint, editor, files).catch((err: unknown) => {
        // No host to tell: rethrow, so the failure reaches the error reporter
        // rather than vanishing.
        if (!onError) throw err;
        onError(err instanceof Error ? err.message : String(err));
      });
      return true;
    };

    const unregisterPaste = editor.registerCommand<ClipboardEvent>(
      PASTE_COMMAND,
      handle,
      COMMAND_PRIORITY_NORMAL,
    );
    const unregisterDrop = editor.registerCommand<DragEvent>(
      DROP_COMMAND,
      handle,
      COMMAND_PRIORITY_NORMAL,
    );
    return () => {
      unregisterPaste();
      unregisterDrop();
    };
  }, [editor, onError, fetchEndpoint]);

  return null;
}
