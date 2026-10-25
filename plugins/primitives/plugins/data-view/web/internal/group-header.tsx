import { type ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SectionHeaderRow } from "@plugins/primitives/plugins/css/plugins/row/web";
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { DATA_VIEW_PICKS } from "@plugins/ui/plugins/tokens/plugins/data-view/core";
import {
  dataPart,
  formatSectionCount,
  type DataViewGroupHeaders,
  type DataViewSection,
  type DataViewSectionIdentity,
} from "@plugins/primitives/plugins/data-view/core";

/** The part names the header's own pieces carry (`SectionHeaderRow` draws them). */
const HEADER_PARTS = {
  rule: dataPart("dv.group-rule")["data-part"],
  chevron: dataPart("dv.group-chevron")["data-part"],
};

/**
 * The identity's colour as a CSS colour: a declared token (`tint`) read
 * through its var, else the user's own `#rrggbb` (`swatch`) — the one thing
 * painted through `style`. `undefined` when the identity has neither.
 */
function identityColor(identity: DataViewSectionIdentity): string | undefined {
  if (identity.tint !== undefined) return `var(${identity.tint})`;
  return identity.swatch;
}

/**
 * The identity chip before a header's label: the section value's glyph on a
 * rounded tile (`groupChip*` tokens). Its ink is the value's colour when it
 * has one, else the header's own — and the tile's default fill is that ink at
 * a low mix (`currentColor`), so one colour paints both.
 */
function GroupChip({
  icon,
  color,
}: {
  icon: NonNullable<DataViewSectionIdentity["icon"]>;
  color: string | undefined;
}): ReactNode {
  return (
    <Center
      as="span"
      aria-hidden
      {...dataPart("dv.group-chip")}
      className={cn(
        "size-group-chip rounded-group-chip bg-group-chip-fill",
        rigidClass(),
      )}
      style={color === undefined ? undefined : { color }}
    >
      <Icon icon={icon} className="size-group-chip-icon" />
    </Center>
  );
}

/**
 * The section colour's dot (an identity with a colour but no glyph — a tag's
 * stored hex), ahead of its label.
 */
function SectionSwatch({ color }: { color: string }): ReactNode {
  return (
    <span
      aria-hidden
      data-section-swatch
      className={cn("inline-block size-2.5 rounded-full", rigidClass())}
      style={{ backgroundColor: color }}
    />
  );
}

/**
 * What precedes the label: the identity chip when the section's value has a
 * glyph, else its colour dot when it has only a colour — a section with no
 * identity draws nothing.
 */
function identityMark(section: DataViewSection<unknown>): ReactNode {
  const identity = section.identity;
  if (identity === undefined) return null;
  const color = identityColor(identity);
  if (identity.icon !== undefined) {
    return <GroupChip icon={identity.icon} color={color} />;
  }
  return color === undefined ? null : <SectionSwatch color={color} />;
}

/**
 * The label: the `groupLabel` part, whose default rung is the row's own
 * `group`. `step="base"`: the label inherited the row's non-compact
 * `text-group` before it was picked, so it does not step down in a compact
 * region (a gallery's cards) either.
 */
function GroupLabel({
  label,
  sub,
}: {
  label: ReactNode;
  sub: boolean;
}): ReactNode {
  return (
    <Text
      pick={DATA_VIEW_PICKS.groupLabel}
      step="base"
      // A nested sub-section's label steps down to medium; important so it
      // beats the picked rung's own weight (a theme's emphasis pick, also
      // important and later in the sheet, still wins).
      className={cn("text-group-label-ink", sub && "font-medium!")}
      {...dataPart("dv.group-label")}
    >
      {label}
    </Text>
  );
}

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
 *
 * Either treatment draws the section's identity (`DataViewSection.identity`)
 * before the label — the chip when it has an `icon`, else a colour dot when it
 * has only a colour — so a section without one renders exactly as before. A
 * nested section below the roots steps its label down to medium. Type, ink and metrics are the
 * `ui/tokens/data-view` group's (`groupLabel` / `groupCount` picks, the
 * `group-header` metrics of `SectionHeaderRow`), every default today's look.
 */
export function DataViewGroupHeader({
  section,
  headerStyle = "standard",
  open,
  onClick,
  action,
  className,
}: DataViewGroupHeaderProps): ReactNode {
  // A nested section's header below the roots steps its label down a weight
  // (medium, against a quiet root's semibold), so the levels read apart.
  const sub = (section.nesting?.depth ?? 0) >= 1;
  const label = (
    <>
      {identityMark(section)}
      <GroupLabel label={section.label} sub={sub} />
    </>
  );
  if (headerStyle === "quiet") {
    return (
      <SectionHeaderRow
        // The `group` role: the heading of a group of rows (its semibold comes
        // with the role), sized by the theme apart from the rows it heads.
        variant="group"
        disclosure="trailing"
        metrics="group-header"
        parts={HEADER_PARTS}
        open={open}
        onClick={onClick}
        className={className}
        {...dataPart("dv.group-header")}
        // The count is part of the label's run here, so the trailing cluster
        // holds only an action — and, like the standard header, nothing at all
        // when there is none.
        actions={
          action == null ? undefined : (
            <RowActions pin={null}>{action}</RowActions>
          )
        }
      >
        {label}
        {/* A quiet header's count is a faint, semibold tally right after its
            label ("Queue 6"). */}
        <Text
          variant="caption"
          tone="faint"
          className="font-semibold"
          {...dataPart("dv.group-count")}
        >
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
      metrics="group-header"
      parts={HEADER_PARTS}
      open={open}
      onClick={onClick}
      className={className}
      {...dataPart("dv.group-header")}
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
      {label}
      {/* The count right beside its label: a faint tally (`groupCountInk`) in
          the `groupCount` part (default the code role — mono figures), part of
          the label's run so the rule starts after it. */}
      <Text
        pick={DATA_VIEW_PICKS.groupCount}
        className="text-group-count-ink"
        {...dataPart("dv.group-count")}
      >
        {formatSectionCount(section.count)}
      </Text>
    </SectionHeaderRow>
  );
}
