import { type ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SectionHeaderRow } from "@plugins/primitives/plugins/css/plugins/row/web";
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import {
  formatSectionCount,
  type DataViewGroupHeaders,
  type DataViewSection,
} from "@plugins/primitives/plugins/data-view/core";

export interface DataViewGroupHeaderProps {
  /** The section this header heads: its `label` and `count` are what it shows. */
  section: DataViewSection<unknown>;
  /** The header treatment — see {@link DataViewGroupHeaders}. Default `"standard"`. */
  headerStyle?: DataViewGroupHeaders;
  /**
   * Expanded state and toggle. Optional: absent, both come from the surrounding
   * collapsible context (`GroupedSections` wraps each section in one); the table,
   * which has no such wrapper, passes them explicitly.
   */
  open?: boolean;
  onClick?: () => void;
  /**
   * A section-scoped affordance (`GroupedSectionsProps.headerActions`), hover-
   * revealed in the trailing cluster. `null`/absent ⇒ no cluster at all.
   */
  action?: ReactNode;
  /** Forwarded to the header row (the band's inline-inset choice is the caller's). */
  className?: string;
}

/**
 * The ONE rendering of a DataView group header, in either treatment — shared by
 * `GroupedSections` (list, gallery, tree, icons) and the table view, which draws
 * its headers inside `data-table`'s subgrid but must look the same.
 *
 * - **standard** — the `group` label, its count right beside it (faint, in
 *   the code role), a hairline filling the rest of the row, and the fold
 *   chevron at the far end — always shown, faint, brightening on hover
 *   (`SectionHeaderRow disclosure="end" rule`). A section's action sits
 *   before the chevron, hover-revealed.
 * - **quiet** — one run: a semibold `group` label, then its count right beside
 *   it (faint, semibold), the fold chevron trailing that run and shown only on
 *   hover / keyboard focus. The count is part of the label's run, so the
 *   trailing cluster holds only an action.
 */
export function DataViewGroupHeader({
  section,
  headerStyle = "standard",
  open,
  onClick,
  action,
  className,
}: DataViewGroupHeaderProps): ReactNode {
  if (headerStyle === "quiet") {
    return (
      <SectionHeaderRow
        // The `group` role: the heading of a group of rows (its semibold comes
        // with the role), sized by the theme apart from the rows it heads.
        variant="group"
        disclosure="trailing"
        open={open}
        onClick={onClick}
        className={className}
        // The count is part of the label's run here, so the trailing cluster
        // holds only an action — and, like the standard header, nothing at all
        // when there is none.
        actions={
          action == null ? undefined : (
            <RowActions pin={null}>{action}</RowActions>
          )
        }
      >
        {section.label}
        {/* A quiet header's count is a faint, semibold tally right after its
            label ("Queue 6"). */}
        <Text variant="caption" tone="faint" className="font-semibold">
          {formatSectionCount(section.count)}
        </Text>
      </SectionHeaderRow>
    );
  }
  return (
    <SectionHeaderRow
      // The `group` role: the heading of a group of rows, a value out of the
      // data (spelled as the data spells it), sized by the theme apart from
      // the rows it heads.
      variant="group"
      // The chevron at the END, always shown but faint, brightening while the
      // header is pointed at; the hairline fills the slack before it.
      disclosure="end"
      rule
      open={open}
      onClick={onClick}
      className={className}
      // This `null` test is the ONLY thing between a section and an empty
      // `RowActions` — which is not nothing: the cluster is a flex item, so an
      // empty one still spends the `gap` before the chevron. Hence the
      // contract that `headerActions` returns `null`, not a component that
      // renders nothing: a component is an element, and an element is never
      // `null`.
      actions={
        action == null ? undefined : (
          <RowActions pin={null}>{action}</RowActions>
        )
      }
    >
      {section.label}
      {/* The count right beside its label: a faint tally in the code role
          (mono figures), part of the label's run so the rule starts after it. */}
      <Text variant="code" tone="faint">
        {formatSectionCount(section.count)}
      </Text>
    </SectionHeaderRow>
  );
}
