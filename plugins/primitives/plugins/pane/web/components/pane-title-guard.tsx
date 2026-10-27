import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import type { SlotListMiddleware } from "@plugins/primitives/plugins/slot-render/web";
import { createContext, useContext, type ReactNode } from "react";

/**
 * True inside a pane header's title cell. `PaneChrome` sets it around the
 * CONTENT of the yielding cell only — the title item's own slot wrapping sits
 * outside it — so what it marks is exactly "rendered by the title".
 */
export const InsidePaneTitleContext = createContext(false);

export const PANE_TITLE_SLOT_ERROR =
  "A render slot mounted inside the pane title. The pane header is ONE slot: " +
  "contribute to `<pane>.Actions` and place the item with a spacer in the " +
  "slot's order file. (A render slot that is an internal part of the title's " +
  "own component declares `defineRenderSlot({ partOfComponent: true })`.)";

/**
 * Closes the one side door into a pane's header row that the API cannot:
 * a `title.component` rendering a slot of its own. Every header control is an
 * item of `pane.Actions`, placed by that slot's order file; a second slot
 * inside the title would be a row the order file cannot see (the Pages
 * `TitleActions` and conversation `Header` slots both got in this way).
 *
 * Only RENDER slots — a list of cells, i.e. a second header — which is exactly
 * where a list middleware runs, so the check is once per slot render rather
 * than once per contribution. A plain or dispatch slot painted once inside a
 * title (a breadcrumb's separator, drawn through `renderIsolated`) is part of
 * the title, not a row. A render slot that is a component's own internal list
 * opts out with `defineRenderSlot({ partOfComponent: true })` — explicit and
 * greppable, so every exception is a declared one.
 *
 * Depth -100: outermost of the list middlewares, so it wraps whatever the
 * others render (reorder's draws its own items rather than its children). The
 * throw lands in the error boundary of the title item rendering the slot —
 * loud, and contained to it.
 */
function PaneTitleSlotGuard({
  slotMeta,
  children,
}: {
  slotMeta: SlotHandle["meta"];
  children: ReactNode;
}): ReactNode {
  const insideTitle = useContext(InsidePaneTitleContext);
  if (insideTitle && slotMeta.partOfComponent !== true) {
    throw new Error(PANE_TITLE_SLOT_ERROR);
  }
  return children;
}

export const paneTitleSlotGuard: SlotListMiddleware = {
  depth: -100,
  Component: PaneTitleSlotGuard,
};
