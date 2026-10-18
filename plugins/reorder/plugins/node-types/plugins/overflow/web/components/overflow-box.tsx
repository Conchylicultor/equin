import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { AdaptiveBar } from "@plugins/primitives/plugins/adaptive-bar/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Children, type ReactNode } from "react";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const moreHorizIcon = symbol("more-horiz");

type OverflowPayload = { label?: string };

/**
 * The `overflow` container node type's box. Two forms, keyed on edit mode:
 *
 * - **live** — an `AdaptiveBar.Collapsed`: the bar's item/panel machinery with
 *   the measurement taken out, so every member relocates into the `⋯` panel —
 *   unless only one member rendered on this row, which the bar keeps inline
 *   (a one-item menu is that item plus a click). Membership here is AUTHORED in the slot's config, which is
 *   exactly what "no width has a say in it" means.
 * - **edit mode** — a labelled inline box (mirroring `HeaderBox`) so an author
 *   can see and drag the bucket's members. A closed panel would hide them from
 *   the pen's drag affordances, so the two branches stay separate on purpose.
 *
 * Each member renders **its own declared form**: an `IconButton` declares the
 * `"row"` rung and becomes a labelled `PanelActionRow`; anything richer renders
 * as itself and stays usable. That is the whole point of the bar — the old
 * `<ActionPresentation mode="menu">` wrapper transformed every member into a
 * menu row, so a member that was not a plain action had nowhere to go.
 *
 * Renders **nothing** when the bucket is empty — and *empty* means "no member
 * actually rendered", not "no member is authored". An item action returns `null`
 * for a row it does not apply to (Close on an already-closed conversation, Move
 * to top on the row that is already top), so a bucket holding five authored
 * actions can still come to nothing on a given row. Two different emptinesses,
 * answered in two places:
 *
 * - **no authored members at all** — the guard below, and the box renders no DOM
 *   whatsoever (not even the bar's always-mounted panel).
 * - **members that all rendered nothing** — the bar's own answer. Each member is
 *   mounted exactly once into its own container, so a container holding no
 *   text and only `display: contents` wrappers (`presence.ts`)
 *   says it drew nothing; such a member is `hidden`, is never eligible for the
 *   panel, and the `⋯` follows the panel's occupancy rather than the member
 *   count. No trigger is painted for a bucket that came to nothing on this row.
 *
 * That replaces action-presentation's `probe` pass, which answered the same
 * question by instantiating every member a SECOND time to draw nothing and be
 * counted — and only ever counted `IconButton`s, so it was blind to a member
 * that hand-rolled its markup. The double mount (its own comment admitted "a
 * member exists twice while its menu is open") is gone with it: one instance,
 * always.
 */
export function OverflowBox({
  payload,
  editMode,
  children,
}: {
  payload: OverflowPayload;
  editMode: boolean;
  children: ReactNode;
}) {
  const label = payload.label || "More";
  const empty = Children.toArray(children).length === 0;

  if (empty) return null;

  if (editMode) {
    return (
      <div className="rounded-md border border-border/50">
        <Inset x="xs" y="xs">
          <Line className="gap-2xs">
            <Icon
              icon={moreHorizIcon}
              className="size-3.5 text-muted-foreground"
            />
            <Text
              variant="caption"
              tone={payload.label ? "default" : "muted"}
              className={cn("truncate", !payload.label && "italic")}
            >
              {label}
            </Text>
          </Line>
        </Inset>
        <Inset x="xs" b="xs">
          {children}
        </Inset>
      </div>
    );
  }

  return (
    <AdaptiveBar.Collapsed label={label}>
      {/*
        The members are opaque pre-rendered contributions — the node type is
        handed a `ReactNode`, never the member list — so position is the only
        identity available, and it is a real one: the bucket's membership and
        order are authored in the config tree, so member `i` is the same member
        on every render of that tree. The id keys the bar's per-item ledger; a
        collapsed bucket measures nothing, so nothing else rides on it.
      */}
      {Children.map(children, (child, i) => (
        <AdaptiveBar.Item id={`m${String(i)}`}>{child}</AdaptiveBar.Item>
      ))}
    </AdaptiveBar.Collapsed>
  );
}
