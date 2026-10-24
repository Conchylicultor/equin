import type { ReactNode } from "react";
import type { DataViewReserve } from "../../core";

/** What the shell knows of a surface's chrome when it checks the rules. */
export interface SurfaceChrome {
  /** A hosted toolbar (no band). */
  hosted: boolean;
  /** A sections toolbar (no band). */
  sectioned: boolean;
  /** A band floating over the view (`ToolbarArrangement.overlay`). */
  overlay: boolean;
  aside: ReactNode;
  asideEnd: ReactNode;
  backdrop: string | undefined;
  reserve: DataViewReserve | undefined;
}

/**
 * The surface keys that only mean something beside a particular chrome,
 * checked once by the shell — each throws rather than being silently dropped:
 *
 * - `aside` needs a band (hosted / sections have none to place it beside);
 * - `asideEnd` and `backdrop` need an overlay band — only a band floating over
 *   the view leaves room for a card on the right, or a canvas under every view;
 * - `reserve` moves the floating cards (the view card of a `backdrop`, the
 *   `asideEnd`) — without one of them there is nothing to move.
 */
export function assertSurfaceChrome(
  storageKey: string,
  chrome: SurfaceChrome,
): void {
  const { hosted, sectioned, overlay, aside, asideEnd, backdrop, reserve } =
    chrome;
  if (aside !== undefined && (hosted || sectioned)) {
    throw new Error(
      `DataView(${storageKey}): \`aside\` needs a band toolbar — a hosted ` +
        "or sections toolbar has no band to place it beside.",
    );
  }
  if (asideEnd !== undefined && !overlay) {
    throw new Error(
      `DataView(${storageKey}): \`asideEnd\` needs an overlay toolbar ` +
        "arrangement — it floats as a card over the view, which only a band " +
        "floating over the view leaves room for.",
    );
  }
  if (backdrop !== undefined && !overlay) {
    throw new Error(
      `DataView(${storageKey}): \`backdrop\` needs an overlay toolbar ` +
        "arrangement — only a band floating over the view leaves the view " +
        "a canvas to stay under every other view.",
    );
  }
  if (
    reserve !== undefined &&
    backdrop === undefined &&
    asideEnd === undefined
  ) {
    throw new Error(
      `DataView(${storageKey}): \`reserve\` moves the floating cards of a ` +
        "`backdrop` or `asideEnd` surface — without either there is no card.",
    );
  }
}
