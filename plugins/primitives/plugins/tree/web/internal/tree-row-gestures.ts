import type { KeyboardEvent, MouseEvent } from "react";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";

/** The row the latest gesture's first click landed on (see `onDoubleClick`). */
let firstClickTarget: EventTarget | null = null;

/**
 * A tree row's pointer and key gestures, as props for the ONE element that is
 * the row — whatever draws it (a flex row, a table row). Click selects (a link
 * click when `selectHref` is given: ⌘/Ctrl- and middle-click open it in a new
 * browser tab), or opens when `clickOpens`; double-click and Enter open. With
 * an open gesture the row is focusable, and the second click of a double-click
 * does not select again, so a click-to-toggle row is not toggled back by the
 * very gesture that opens it.
 */
export function treeRowGestures({
  onSelect,
  selectHref,
  onOpen,
  clickOpens = false,
}: {
  onSelect?: () => void;
  selectHref?: () => string;
  onOpen?: () => void;
  clickOpens?: boolean;
}) {
  // A link row's select click reads its gestures (⌘-click opens the href in a
  // browser tab); the aux/mousedown halves catch the middle button.
  const selectLink =
    onSelect && selectHref
      ? linkProps({ open: onSelect, href: selectHref })
      : undefined;
  const selectClick = selectLink?.onClick ?? onSelect;
  return {
    onClick: onOpen
      ? (e: MouseEvent) => {
          // `detail` counts the clicks of one gesture; the second click of
          // a double-click belongs to `onOpen`, not to another select.
          if (e.detail > 1) return;
          firstClickTarget = e.currentTarget;
          if (clickOpens) onOpen();
          else if (selectLink) selectLink.onClick(e);
          else onSelect?.();
        }
      : selectClick,
    onAuxClick: selectLink?.onAuxClick,
    onMouseDown: selectLink?.onMouseDown,
    onDoubleClick:
      onOpen && !clickOpens
        ? (e: MouseEvent) => {
            // Only a double-click whose FIRST click landed on this row: when
            // that click opened something and the row under the pointer was
            // replaced in between, the second click is not this row's.
            if (e.currentTarget !== firstClickTarget) return;
            onOpen();
          }
        : undefined,
    tabIndex: onOpen ? 0 : undefined,
    onKeyDown: onOpen
      ? (e: KeyboardEvent) => {
          // Only the row's own key press — never one bubbling from a
          // control inside it (a rename input, an action button).
          if (e.key !== "Enter" || e.target !== e.currentTarget) return;
          e.preventDefault();
          onOpen();
        }
      : undefined,
  };
}
