import type { ReactNode } from "react";
import { $getNodeByKey, type NodeKey } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
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
 *   highlight inside it (`select-none`); when a selection spans the token,
 *   Lexical reports the node selected and the whole frame gets a ring. Copying
 *   that selection carries the node itself, so it pastes as the same token in
 *   any other editor.
 * - **Removable.** A hover/focus-revealed × deletes the node.
 * - **Painted inside its own box.** The ring is an inward outline (painted over
 *   the token, unlike an inset shadow its own fill would hide) and the × sits within the
 *   token's right edge: a token on the first line of a scrolling editable whose
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
  const [isSelected] = useLexicalNodeSelection(nodeKey);
  if (!editor.isEditable()) return <>{children}</>;
  return (
    <Inline
      gap="none"
      className={cn(
        hoverRevealGroup,
        "relative select-none align-middle rounded-md",
        isSelected && "outline-2 outline-solid outline-ring -outline-offset-2",
      )}
      contentEditable={false}
      data-token-selected={isSelected || undefined}
    >
      {children}
      <Pin to="right" offset="2xs">
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
