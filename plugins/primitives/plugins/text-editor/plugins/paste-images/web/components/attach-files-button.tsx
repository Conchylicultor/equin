import { useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { attachFiles } from "../internal/attach-files";

const addIcon = symbol("add");

/**
 * The "+" that attaches files to the editor it sits in: a file picker whose
 * picks take the same path as a paste or a drop (see `attachFiles`). Must be
 * rendered inside the editor — a `TextEditor`'s `bottomSlot`, as the composer
 * bar does.
 */
export function AttachFilesButton({
  disabled,
  onError,
}: {
  disabled?: boolean;
  onError?: (msg: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const fetchEndpoint = useFetchEndpoint();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Reset so picking the same file again still fires a change.
          e.target.value = "";
          if (files.length === 0) return;
          attachFiles(fetchEndpoint, editor, files).catch((err: unknown) => {
            if (!onError) throw err;
            onError(err instanceof Error ? err.message : String(err));
          });
        }}
      />
      <IconButton
        icon={addIcon}
        label="Attach files"
        tooltip="Attach files — or paste or drop them into the field"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      />
    </>
  );
}
