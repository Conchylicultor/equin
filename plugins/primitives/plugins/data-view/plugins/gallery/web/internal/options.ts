/**
 * Per-view options for the gallery view, threaded through
 * `DataViewProps.viewOptions.gallery` and surfaced as the opaque
 * `DataViewRenderProps.options`.
 */
export interface GalleryViewOptions {
  /**
   * The card's shape — a closed set, never a body override, so every shape
   * still draws every affordance the surface declared (fields, item actions,
   * selection, activation):
   *
   * - `"cover"` (default) — the cover IS the card: the 16/10 frame, then the
   *   three text lines under it (`DataCard`).
   * - `"panel"` — a card with no picture, for records that have none (a site,
   *   a server, an account): a raised panel whose head is the leading field
   *   (the mark) beside the title + indicators and the subtitle, with the
   *   tokens line as a hairline-ruled footer (`PanelCard`). The schema's cover
   *   is not drawn.
   */
  card?: "cover" | "panel";
}
