import { createContext, useContext } from "react";

/**
 * The part of a display its host covers with floating chrome, in px from each
 * edge — the immersive player's section dock at the right. A host hands it to
 * `PlayerDisplay`; the display never sees the chrome itself.
 */
export interface DisplayCover {
  right: number;
}

export const NO_COVER: DisplayCover = { right: 0 };

export const DisplayCoverContext = createContext<DisplayCover>(NO_COVER);

/**
 * The cover a `bleed` display paints under: its ground (and the rules drawn on
 * it) runs to the window's edge while its content keeps out of the covered
 * edges. Always {@link NO_COVER} for a display that does not bleed —
 * `PlayerDisplay` keeps that one out of the cover instead.
 */
export function useDisplayCover(): DisplayCover {
  return useContext(DisplayCoverContext);
}
