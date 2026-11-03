import type { ReactNode } from "react";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";

/**
 * Per-view options for the list view, threaded through
 * `DataViewProps.viewOptions.list` and surfaced as the opaque
 * `DataViewRenderProps.options`.
 */
export interface ListViewOptions<TRow> {
  /**
   * Full row-body override (escape hatch). Owns its own content; still wrapped
   * in the selectable/clickable <Row>.
   */
  renderRow?: (row: TRow) => ReactNode;
  /**
   * The row's leading glyph when `renderRow` owns the body — drawn by the
   * list, ahead of the body, so the list can wrap it in the row's
   * expand/collapse disclosure (a merged disclosure puts the chevron in the
   * glyph's place on hover). A glyph drawn inside `renderRow` instead sits in
   * the row's own control, where no disclosure can reach it. Default row
   * chrome only.
   */
  renderLeading?: (row: TRow) => ReactNode;
  /**
   * Row shape: 2 stacks the `line2` slot under the title — adjacent text
   * terms on one line, each chip group on a line of its own — with the
   * trailing fields as one right-aligned column beside them; 1 puts
   * everything on the title's line, the trailing fields in aligned slots.
   * Default: 2 when the placement puts anything on line 2 (the record recipe
   * sends prose and identifiers there), else 1.
   */
  lines?: 1 | 2;
  /**
   * Row density. Default follows the surface's `DataViewProps.density`:
   * "sm" when the surface declared itself compact, "md" otherwise. Set it here
   * to pin a density regardless of what the surface asked for.
   */
  size?: "sm" | "md";
  /**
   * The chrome each row is drawn with. `"row"` (default) is the `Row`
   * primitive. `"tree"` draws every row through the tree primitive's
   * `TreeRowChrome` at depth 0 — its height (`treeRowH`), indent, icon box,
   * hover, selected tier and action cluster — so a flat list shown beside a
   * tree of the same records (Pages' Favorites over its page tree) is the
   * same row by construction, not a second hand-tuned look. In this chrome a
   * row is one label line: the title (its read rendering — never the
   * click-to-edit cell, since the label is the row's navigation target)
   * truncates and every other body field
   * renders as a rigid inline cell after it, exactly as the tree view draws
   * its secondary fields; `lines` does not apply.
   */
  rowChrome?: "row" | "tree";
  /**
   * The disclosure look this list pins for its rows' expand/collapse (a
   * `Tree.Disclosure` variant id: `"merged"` — the chevron in the glyph's
   * place, on hover only; `"column"`; `"dimmed-leaf"`), whatever its app's
   * tree-disclosure config says — so one list can wear a look without
   * changing every tree of its app. Absent → the app's. The default row
   * chrome only (a `rowChrome: "tree"` row wears its app's look).
   */
  disclosureVariant?: string;
  /**
   * Per-row title className, composed after the row tone — the list twin of
   * the tree view's `labelClassName` (e.g. the open record's row in a heavier
   * weight).
   */
  labelClassName?: (row: TRow) => ClassName | undefined;
  /**
   * Per-row detail, shown UNDER the row when it is expanded. Present ⇒ every
   * row leads with the tree's disclosure in its glyph's place (the theme's
   * `Tree.Disclosure` variant; in the action cluster instead on a list that
   * also has `attach`, whose rows the lead folds), and an expanded row renders `detail(row)` in a band
   * below it — a sibling of the row, never inside it, so the detail may hold
   * its own controls whatever the row's activation is. Which rows are open is
   * the view's expand map (per surface, view instance and row; per device),
   * like a tree's — never domain data. The default `Row` chrome only:
   * combining it with `rowChrome: "tree"` throws.
   */
  detail?: (row: TRow) => ReactNode;
  /**
   * The row's action cluster stays painted at rest, not only while the row
   * is hovered — for a short list whose item action IS the point of the row
   * (a page's places beside a map, each with its Save). The cluster keeps its
   * trailing track either way; an action with nothing to offer for a row
   * draws nothing. Default off: a list keeps its title's width in narrow
   * surfaces.
   */
  actionsAtRest?: boolean;
  /**
   * A caption row over the list: the title field's label on the left, each
   * trailing (trail / edge) field's label over its aligned slot. Default off.
   * Also the view type's `configSchema` option, so a user turns it on from the view's
   * settings (the instance's config-row value arrives merged into `options`).
   */
  columnCaptions?: boolean;
}
