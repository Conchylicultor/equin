import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { InlineTokenExtension } from "@plugins/primitives/plugins/text-editor/plugins/token-extension/core";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { registerTokenBoundaries } from "../../core";

/**
 * Keeps every inline token separated from what would fuse with it once
 * serialized (two id chips side by side, a letter typed against a chip), so the
 * saved text reads back as the same tokens — see `registerTokenBoundaries`.
 *
 * Re-registers only when the SET of families changes: hosts rebuild their
 * extension list on every render (the registries are read at call time), and
 * the transforms are keyed by node class, not by list identity.
 */
export function TokenBoundaryPlugin({
  extensions,
}: {
  extensions: readonly InlineTokenExtension[];
}) {
  const [editor] = useLexicalComposerContext();
  const extensionsRef = useLatestRef(extensions);
  const familyKey = extensions.map((ext) => ext.id).join("\n");

  // `familyKey` is what invalidates this registration; the list itself is read
  // through the ref, so a same-set rebuild does not re-register.
  useEffect(() => {
    return registerTokenBoundaries(editor, extensionsRef.current);
  }, [editor, extensionsRef, familyKey]);

  return null;
}
