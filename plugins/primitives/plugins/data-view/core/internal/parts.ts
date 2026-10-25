/**
 * The closed vocabulary of DataView PARTS — the elements a mock's selectors
 * are mapped onto (`<app>/e2e/<proto>.parts.json`) and the part-metrics diff
 * measures (`prototypes/compare`'s `--metrics`). A real component stamps its
 * part with `{...dataPart("dv.card-title")}`; an unknown name is a tsc error
 * here and a failure in the diff. The pane spells its own two
 * (`pane.header`, `pane.title`) literally.
 */
export const DATA_VIEW_PARTS = [
  // Toolbar
  "dv.toolbar",
  "dv.views-pill",
  "dv.view-chip",
  "dv.view-chip-active",
  "dv.view-add",
  "dv.tools-pill",
  "dv.search",
  "dv.control",
  "dv.pill-divider",
  "dv.create",
  // Gallery card
  "dv.card",
  "dv.cover",
  "dv.cover-primary",
  "dv.cover-actions",
  "dv.card-meta",
  "dv.card-title",
  "dv.card-subtitle",
  "dv.card-tokens",
  "dv.card-token",
  "dv.card-token-icon",
  // Group headers
  "dv.group",
  "dv.group-header",
  "dv.group-chip",
  "dv.group-label",
  "dv.group-count",
  "dv.group-rule",
  "dv.group-chevron",
  // Table
  "dv.table",
  "dv.table-frame",
  "dv.column-header-row",
  "dv.column-header",
  "dv.row",
  "dv.cell",
  "dv.thumb",
  "dv.title-cell",
  "dv.title-cell-title",
  "dv.title-cell-subtitle",
] as const;

export type DataViewPart = (typeof DATA_VIEW_PARTS)[number];

/** The attribute a part is stamped with — spread on the part's element. */
export function dataPart(part: DataViewPart): { "data-part": DataViewPart } {
  return { "data-part": part };
}
