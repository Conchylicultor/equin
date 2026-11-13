import {
  FloatingSurface,
  type FloatingSurfaceProps,
} from "@plugins/primitives/plugins/overlay/plugins/floating-surface/web";
import { caretAnchor } from "../internal/caret-anchor";
import type { CaretQuery } from "../internal/use-caret-trigger";

export interface CaretTriggerMenuProps extends Pick<
  FloatingSurfaceProps,
  "width" | "padding" | "maxHeight" | "children"
> {
  /** The `useCaretQuery` handle — supplies the reposition seed, dismissal, and id. */
  caret: CaretQuery;
  /** The surface's visibility — wire the menu's `surfaceOpen`. */
  open: boolean;
}

/**
 * The caret-anchored surface for a trigger menu: `FloatingSurface` bound to the
 * live caret rect, repositioned on each query keystroke, dismissed on
 * outside-press. Each host supplies its own body as `children`.
 *
 * Taking the whole `caret` handle rather than loose `query` / `onDismiss` props
 * means a host cannot wire a different trigger's dismissal into this surface.
 *
 * `data-caret-trigger` makes the arbiter's at-most-one-owner invariant
 * observable from the DOM (`e2e/caret-trigger-wedge.ts` asserts on it); the
 * `contents` wrapper takes no box, so it cannot perturb the surface's layout.
 */
export function CaretTriggerMenu({
  caret,
  open,
  children,
  ...rest
}: CaretTriggerMenuProps) {
  return (
    <FloatingSurface
      open={open}
      // A trigger menu is a list of menu rows: its strips and empty states sit
      // on the rows' text edge.
      rows
      // Fall back to the editor's root rect when the live caret rect is all-zero
      // — a collapsed caret in an EMPTY block yields no usable rect (the gutter-+
      // draft flow opens on a fresh empty block). Anchoring to the block's own
      // editable element still lands the menu just below it. Mirrors url-paste.
      anchor={caretAnchor(
        () => caret.editor.getRootElement()?.getBoundingClientRect() ?? null,
      )}
      reposition={caret.query}
      onDismiss={caret.dismiss}
      {...rest}
    >
      <div data-caret-trigger={caret.id} className="contents">
        {children}
      </div>
    </FloatingSurface>
  );
}
