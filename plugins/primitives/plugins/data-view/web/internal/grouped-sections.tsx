import { type ReactNode } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  StickyStack,
  StickyStackItem,
} from "@plugins/primitives/plugins/css/plugins/sticky/plugins/stack/web";
import {
  CollapsibleProvider,
  CollapsibleContent,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  DATA_VIEW_HEADER_OFFSET_VAR,
  type DataViewGroupHeaders,
  type DataViewSection,
} from "@plugins/primitives/plugins/data-view/core";
import { DataViewGroupHeader } from "./group-header";

export interface GroupedSectionsProps {
  /** The grouped sections — every `key` non-null. The ungrouped single implicit
   *  section (`key === null`) is the view's own headerless fast-path and never
   *  reaches here. */
  sections: DataViewSection<unknown>[];
  collapsedSections?: ReadonlySet<string>;
  setSectionCollapsed?: (key: string, collapsed: boolean) => void;
  /**
   * An affordance scoped to ONE section, rendered in that section's header's
   * trailing cluster (before the fold chevron) — the tree's fold-this-group toggle today, and the seam
   * anything else section-scoped goes through tomorrow. Return `null` for a
   * section that has nothing to offer; the wrapper is then not rendered either,
   * so a header without an action keeps the exact node it has always had.
   *
   * The count and the action want opposite treatments, which is why they sit
   * apart: the count is information and reads at rest (in the label's run),
   * while an action is something you reach for, so it appears on hover. `RowActions` already
   * separates `pin` (positioning) from `alwaysVisible` (reveal), so an inline
   * cluster that still reveals costs nothing new in `Row`, `SectionHeaderRow` or
   * `row-actions` — it rides the row's own `group/row-actions`, published
   * unconditionally by `rowActionsAnchor` in `Row`'s chrome class.
   *
   * The header is itself the section's collapse trigger, and an action sitting
   * on it must not collapse the section it folds. Nothing here guards that:
   * `RowActions`' button `Stack` already stops `onClick` AND `onPointerDown`,
   * for exactly this reason.
   *
   * This is deliberately NOT the `hover-reveal` primitive. That plugin's own
   * CLAUDE.md says in as many words that a cluster of row actions belongs to
   * `row-actions`; using both would put two competing reveal systems — one CSS
   * group, one JS state — on a single row.
   */
  headerActions?: (section: DataViewSection<unknown>) => ReactNode;
  /**
   * The header treatment — the surface's `DataViewProps.groupHeaders`, threaded
   * through the view's render props. Absent ⇒ `"standard"`: the label, its
   * faint count beside it, a hairline filling the row and the fold chevron at
   * the far end (always shown, faint, brightening on hover).
   *
   * `"quiet"` reads the header as one run — a semibold label, then its count
   * right beside it ("Queue 6", faint and semibold) — with the fold chevron
   * trailing that run and shown only on hover / keyboard focus
   * (`SectionHeaderRow disclosure="trailing"`). The count moves from the
   * trailing cluster into the label's run; a section's `headerActions` stay in
   * the trailing cluster, hover-revealed as before. Its label sits on the
   * rows' TEXT column rather than on their pill edge: the rail is paid by the
   * sticky band and the header row keeps its own row padding, exactly like a
   * body row.
   */
  headerStyle?: DataViewGroupHeaders;
  /** This section's body — rendered inside the collapsible content, so
   *  collapsing the group hides it. A flat view returns its `SectionBody` here,
   *  which carries the section's fold line. */
  children: (section: DataViewSection<unknown>) => ReactNode;
}

/**
 * The group-header chrome shared by every flat view child's grouped branch — the
 * render-side twin of `useDataViewSections`. The pipeline that *computes* the
 * sections and the chrome that *presents* them live side by side on purpose: when
 * each view hand-rolled this, they silently drifted (the gallery's headers never
 * pinned at all, while list's and table's stacked). One home makes that
 * divergence unrepresentable for the next view child.
 *
 * Group headers accumulate: with few enough groups every header stays pinned, each
 * below the last (StickyStack sums their measured heights), so you can see every
 * group you scrolled past. Past the stack's cap it degrades to the swap hand-off —
 * each arriving header covers the pinned one — because N pinned headers would eat
 * the viewport.
 *
 * The whole set shares THIS `<Stack>` as its sticky containing block, which is what
 * makes stacking possible: a per-group wrapper would re-bound each header to its
 * own group and un-pin it as the group scrolls away. Hence `<CollapsibleProvider>`
 * (no DOM) rather than `<Collapsible>`, and hence the header/content landing as
 * direct children of the Stack — a flex column with `gap="none"`, so each view's
 * arrangement is unchanged.
 *
 * `base` stacks the first header BELOW the DataView toolbar by reading the
 * host-published `--dv-header-offset` (its measured height). `mask` keeps rows from
 * showing through; `raised` sits above the (relative, in manual-order) rows while
 * the toolbar's `nav` keeps the headers sliding under it at the hand-off.
 *
 * The header's horizontal inset is the ambient **rail** (`rail-follow`),
 * the same rail every view body reads — so a group header and its rows line up on
 * one edge for free, and there is no longer a per-view `headerClassName` axis to
 * keep in sync with each body's padding.
 *
 * **The `table` view is the documented exception** and composes `StickyStack`
 * itself (inside `data-table`) under this same policy: its headers are
 * `col-span-full` rows of the subgrid, so the chrome cannot own a `<Stack>` without
 * displacing them out of the grid and breaking column alignment. The header NODE
 * is still the same one: both render `DataViewGroupHeader`, so a table's group
 * header honours `headerStyle` exactly like a list's.
 */
export function GroupedSections({
  sections,
  collapsedSections,
  setSectionCollapsed,
  headerActions,
  headerStyle = "standard",
  children,
}: GroupedSectionsProps): ReactNode {
  const quiet = headerStyle === "quiet";
  return (
    <Stack gap="none">
      <StickyStack
        keys={sections.map((section) => section.key!)}
        base={`var(${DATA_VIEW_HEADER_OFFSET_VAR}, 0px)`}
      >
        {sections.map((section) => {
          const key = section.key!;
          const collapsed = collapsedSections?.has(key) ?? false;
          const action = headerActions?.(section);
          return (
            <CollapsibleProvider
              key={key}
              open={!collapsed}
              onOpenChange={(open) => setSectionCollapsed?.(key, !open)}
            >
              <StickyStackItem
                itemKey={key}
                mask
                layer="raised"
                // A quiet header pays the rail on its BAND and keeps the row's
                // own `p-row` inside it, so its label lands on the rows' TEXT
                // column (rail + row pad) — a caption over the rows. A standard
                // header pays the rail on the row itself, which replaces the
                // row's inline pad, so its label sits on the row pills' edge.
                className={quiet ? "rail-follow" : undefined}
              >
                <DataViewGroupHeader
                  section={section}
                  headerStyle={headerStyle}
                  action={action}
                  className={quiet ? undefined : "rail-follow"}
                />
              </StickyStackItem>
              <CollapsibleContent>{children(section)}</CollapsibleContent>
            </CollapsibleProvider>
          );
        })}
      </StickyStack>
    </Stack>
  );
}
