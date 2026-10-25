import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { SlotItemMiddleware } from "@plugins/primitives/plugins/slot-render/web";
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
 * Only RENDER slots — a list of cells, i.e. a second header. A plain or
 * dispatch slot painted once inside a title (a breadcrumb's separator, drawn
 * through `renderIsolated`, whose contributions carry no `_slot`) is part of
 * the title, not a row. A render slot that is a component's own internal list
 * opts out with `defineRenderSlot({ partOfComponent: true })` — explicit and
 * greppable, so every exception is a declared one.
 *
 * Priority 200: innermost of the item middlewares, so the throw lands in the
 * offending item's own error boundary — loud, and contained to it.
 */
function PaneTitleSlotGuard({
  contribution,
  children,
}: {
  slotId: string;
  contribution: Contribution;
  children: ReactNode;
}): ReactNode {
  const insideTitle = useContext(InsidePaneTitleContext);
  const meta = contribution._slot?.meta;
  if (insideTitle && meta?.kind === "render" && meta.partOfComponent !== true) {
    throw new Error(PANE_TITLE_SLOT_ERROR);
  }
  return children;
}

export const paneTitleSlotGuard: SlotItemMiddleware = {
  depth: 200,
  Component: PaneTitleSlotGuard,
};
