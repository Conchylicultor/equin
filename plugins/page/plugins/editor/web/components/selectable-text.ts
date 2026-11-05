/**
 * Read-only text inside a void block that the user can still SELECT and copy
 * natively — a table's cells. Spread onto the element holding that text.
 *
 * The editable block list is `user-select: none` outside a block's editing
 * surface (`block-selection-scope.css`), which also took away selecting a
 * table's words. This marker is the surface's second exemption, and it is
 * honoured exactly like an editing host for the pointer gesture
 * (`block-editor.tsx`'s `onPointerDown`): the press belongs to the browser
 * while it stays in the block, and the drag becomes a block range the moment
 * it crosses into another row — so a native selection anchored here can never
 * run across the document.
 */
export const selectableText = { "data-selectable-text": "" } as const;

/** Did this target land inside a {@link selectableText} region? */
export function isInsideSelectableText(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("[data-selectable-text]") !== null
  );
}
