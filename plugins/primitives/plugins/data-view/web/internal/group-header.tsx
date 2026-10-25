import { type ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SectionHeaderRow } from "@plugins/primitives/plugins/css/plugins/row/web";
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCollapsibleContext } from "@plugins/primitives/plugins/collapsible/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { DATA_VIEW_PICKS } from "@plugins/ui/plugins/tokens/plugins/data-view/core";
import {
  dataPart,
  formatSectionCount,
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
 * The `groupHeaderStyle` token, read by container style queries: the rule
 * shows only under `rule`, and the label wears a soft pill only under `pill`.
 * A style query reads the property off the element's parent, and the token is
 * inherited from the theme scope, so no wrapper is needed.
 */
const RULE_SHOWN = cn(
  "hidden [@container_style(--group-header-style:rule)]:block",
);
const PILL_LABEL =
  "[@container_style(--group-header-style:pill)]:bg-group-pill-fill [@container_style(--group-header-style:pill)]:px-group-pill [@container_style(--group-header-style:pill)]:rounded-full";

/**
 * The label: the `groupLabel` part, whose default rung is the row's own
 * `group`. `step="base"`: the label inherited the row's non-compact
 * `text-group` before it was picked, so it does not step down in a compact
 * region (a gallery's cards) either.
 *
 * Its ink is `groupLabelInk` (muted) while the section is open, faint while
 * it is shut; inside a `pill` it reads at the foreground (muted when shut), as
 * the pill's fill already sets it apart.
 */
function GroupLabel({
  label,
  sub,
  open,
}: {
  label: ReactNode;
  sub: boolean;
  open: boolean;
}): ReactNode {
  return (
    <Text
      pick={DATA_VIEW_PICKS.groupLabel}
      step="base"
      // A nested sub-section's label steps down to medium; important so it
      // beats the picked rung's own weight (a theme's emphasis pick, also
      // important and later in the sheet, still wins).
      className={cn(
        open
          ? "text-group-label-ink [@container_style(--group-header-style:pill)]:text-foreground"
          : "text-faint-foreground [@container_style(--group-header-style:pill)]:text-muted-foreground",
        PILL_LABEL,
        sub && "font-medium!",
      )}
      {...dataPart("dv.group-label")}
    >
      {label}
    </Text>
  );
}

export interface DataViewGroupHeaderProps {
  /** The section this header heads: its `label` and `count` are what it shows. */
  section: DataViewSection<unknown>;
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
 * The ONE rendering of a DataView group header — shared by `GroupedSections`
 * (list, gallery, tree, icons) and the table view, which draws its headers
 * inside `data-table`'s subgrid but must look the same.
 *
 * One run, `[identity][label][count][rule][chevron]`, then a section's action
 * in the trailing cluster (hover-revealed): the section's identity
 * (`DataViewSection.identity` — the chip when it has an `icon`, else a colour
 * dot), the `group` label, its count right beside it (faint), and the fold
 * chevron trailing the run (`SectionHeaderRow disclosure="trailing"`: shown on
 * hover / keyboard focus and while the section is collapsed). The theme's
 * `groupHeaderStyle` token picks the treatment in CSS, never in props:
 *
 * - **caption** (default) — the run alone, a caption over the rows.
 * - **rule** — a hairline fills the row between the count and the chevron,
 *   which then sits at the row's far end.
 * - **pill** — the label wears a soft pill (`groupPillFill`, `groupPillPadX`).
 *
 * A nested section below the roots steps its label down to medium. Type, ink
 * and metrics are the `ui/tokens/data-view` group's (`groupLabel` /
 * `groupCount` picks, the `group-header` metrics of `SectionHeaderRow`).
 */
export function DataViewGroupHeader({
  section,
  open: openProp,
  onClick,
  action,
  className,
}: DataViewGroupHeaderProps): ReactNode {
  const ctx = useCollapsibleContext();
  const open = openProp ?? ctx?.open ?? true;
  // A nested section's header below the roots steps its label down a weight
  // (medium, against a root's semibold), so the levels read apart.
  const sub = (section.nesting?.depth ?? 0) >= 1;
  return (
    <SectionHeaderRow
      // The `group` role: the heading of a group of rows, a value out of the
      // data (spelled as the data spells it), sized by the theme apart from
      // the rows it heads.
      variant="group"
      disclosure="trailing"
      rule
      ruleClassName={RULE_SHOWN}
      metrics="group-header"
      parts={HEADER_PARTS}
      open={openProp}
      onClick={onClick}
      className={className}
      {...dataPart("dv.group-header")}
      // This `null` test is the ONLY thing between a section and an empty
      // `RowActions` — which is not nothing: the cluster is a flex item, so an
      // empty one still spends the row's `gap`. Hence the contract that
      // `headerActions` returns `null`, not a component that renders nothing:
      // a component is an element, and an element is never `null`.
      actions={
        action == null ? undefined : (
          <RowActions pin={null}>{action}</RowActions>
        )
      }
    >
      {identityMark(section)}
      <GroupLabel label={section.label} sub={sub} open={open} />
      {/* The count right beside its label: a faint tally (`groupCountInk`) in
          the `groupCount` part, part of the label's run so the rule (under
          `rule`) starts after it. */}
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
