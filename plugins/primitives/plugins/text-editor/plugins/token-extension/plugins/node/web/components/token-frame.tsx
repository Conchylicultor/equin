import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  type LexicalEditor,
  type NodeKey,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import {
  hoverRevealGroup,
  hoverRevealTargetWithGroupFocus,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const closeIcon = symbol("close");

/**
 * The editing chrome every decorated inline token wears in an editable editor —
 * a task chip, a pasted image, an attached file alike — so none of them has to
 * restate it.
 *
 * - **One object, never characters.** The browser paints no per-character
 *   highlight inside it (`select-none`), so the frame paints its own: a text
 *   selection that spans the token tints the whole token with the theme's
 *   text-selection colour — the same fill as the selected text around it, so it
 *   reads as part of the selection — and a selection of the token alone (a
 *   click, ← / → onto it) adds a ring. Both are drawn ABOVE the content: a
 *   token whose content is a positioned box (an image thumbnail's button) would
 *   cover anything painted on the frame itself. Copying the selection carries
 *   the node itself, so it pastes as the same token in any other editor.
 * - **Removable.** A hover/focus-revealed × in its top-right corner deletes
 *   the node — the same corner on a one-line chip and a tall image.
 * - **Painted inside its own box.** The ring is an inward outline (painted over
 *   the token, unlike an inset shadow its own fill would hide) and the × sits within the
 *   token's corner: a token on the first line of a scrolling editable whose
 *   theme gives the text no padding (the agent manager's composer) would
 *   otherwise have anything drawn past its edges clipped by the scroll box.
 *
 * A read-only editor gets the content bare: there is nothing to select or
 * remove there.
 *
 * Only for a `decorate()` render, which is what puts it inside a
 * `LexicalComposer`.
 */
export function TokenFrame({
  nodeKey,
  removeLabel,
  children,
}: {
  nodeKey: NodeKey;
  /** The × button's accessible name — "Remove image", "Remove file". */
  removeLabel: string;
  children: ReactNode;
}) {
  const [editor] = useLexicalComposerContext();
  const selected = useTokenSelection(editor, nodeKey);
  if (!editor.isEditable()) return <>{children}</>;
  return (
    <Inline
      gap="none"
      className={cn(
        hoverRevealGroup,
        "relative select-none align-middle rounded-md",
      )}
      contentEditable={false}
      data-token-selected={selected ?? undefined}
    >
      {children}
      {selected && (
        // Last in DOM order, so it paints over a positioned child; never eats
        // a click meant for the content beneath.
        <Layer
          as="span"
          decorative
          aria-hidden
          className={cn(
            "rounded-md bg-text-selection",
            selected === "node" &&
              "outline-2 outline-solid outline-ring -outline-offset-2",
          )}
        />
      )}
      <Pin to="top-right" offset="2xs">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            editor.update(() => {
              $getNodeByKey(nodeKey)?.remove();
            });
          }}
          className={cn(
            hoverRevealTargetWithGroupFocus,
            "bg-background/90 border-border text-foreground block size-4 rounded-full border",
          )}
          aria-label={removeLabel}
        >
          <Center className="size-full">
            <Icon icon={closeIcon} className="size-3" />
          </Center>
        </button>
      </Pin>
    </Inline>
  );
}

/**
 * How the current selection covers the token: `"node"` when the token itself
 * is the selected object (Lexical's NodeSelection), `"range"` when a
 * non-collapsed text selection spans it, `null` otherwise.
 */
type TokenSelection = "node" | "range" | null;

function useTokenSelection(
  editor: LexicalEditor,
  nodeKey: NodeKey,
): TokenSelection {
  const subscribe = useCallback(
    (onChange: () => void) => editor.registerUpdateListener(onChange),
    [editor],
  );
  const read = useCallback(
    () =>
      editor.getEditorState().read((): TokenSelection => {
        const selection = $getSelection();
        if ($isNodeSelection(selection))
          return selection.has(nodeKey) ? "node" : null;
        if ($isRangeSelection(selection) && !selection.isCollapsed())
          return selection.getNodes().some((n) => n.getKey() === nodeKey)
            ? "range"
            : null;
        return null;
      }),
    [editor, nodeKey],
  );
  return useSyncExternalStore(subscribe, read);
}
