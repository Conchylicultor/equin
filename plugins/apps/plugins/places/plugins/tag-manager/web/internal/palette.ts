/**
 * The tag colours the colour picker offers — the prototype's eighteen: warm to
 * cool, then earth and neutral tones. Hex, because a tag's colour is stored as
 * `#rrggbb` (`UpdatePlaceTagBodySchema`) and painted on map tiles that do not
 * follow the app theme.
 */
export const TAG_PALETTE = [
  "#f97316",
  "#ef4444",
  "#e11d48",
  "#ec4899",
  "#a855f7",
  "#6366f1",
  "#3b82f6",
  "#0ea5e9",
  "#14b8a6",
  "#16a34a",
  "#84cc16",
  "#eab308",
  "#a16207",
  "#78716c",
  "#94a3b8",
  "#22c55e",
  "#0f766e",
  "#1e293b",
] as const;
