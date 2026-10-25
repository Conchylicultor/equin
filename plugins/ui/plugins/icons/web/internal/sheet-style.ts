import type { CSSProperties } from "react";

/**
 * How a sheet of `<symbol>`s sits in the page: rendered but taking no room and
 * painting nothing. Not `display: none` — a derived active form's `<mask>`
 * under a display-none ancestor is not rendered, so every `<use>` of it would
 * draw nothing.
 */
export const SHEET_STYLE: CSSProperties = {
  position: "absolute",
  width: 0,
  height: 0,
  overflow: "hidden",
  pointerEvents: "none",
};
