import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import type React from "react";
import {
  CollapsibleChevron,
  useCollapsibleContext,
  type CollapsibleWarmHandlers,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  hoverRevealClass,
  useHoverReveal,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { Row } from "./row";

/**
 * What the header's text IS, which is what picks its treatment.
 *
 * - **`eyebrow`** (default) — a label the APP wrote: "Tokens", "Parameters",
 *   "Preview". Small caps, because caps mark it as chrome naming the run of
 *   rows below it rather than as content.
 * - **`title`** — the section's own name, at body weight. What `SectionCard`
 *   uses.
 * - **`value`** — a value out of the DATA, not a label at all: a DataView's
 *   group-by header, which is whatever the grouped column happens to hold
 *   ("Mine", "In progress", `agent-manager`). It gets the eyebrow's size and
 *   tone and NOT its caps, because uppercasing a value misspells it — a
 *   composition name is a namespace component stored lowercase, and a header
 *   reading `AGENT-MANAGER` shows an identifier in a form nothing stores.
 *
 * - **`group`** — a QUIET group-by header: a value out of the data like
 *   `value`, set as the `group` type role (the heading of a run of rows), whose
 *   size, line-height and semibold weight the theme owns as one — no weight
 *   class beside it, since a single-property `font-*` beats a role's bundled
 *   weight in Tailwind's stylesheet order.
 *
 * The split exists because a group header used to take the `eyebrow` default by
 * omission, which is how the app came to shout its own data back at the reader.
 */
export type SectionHeaderVariant = "eyebrow" | "title" | "value" | "group";

const VARIANT_CLASS: Record<SectionHeaderVariant, string> = {
  eyebrow:
    "text-caption font-medium uppercase tracking-wider text-muted-foreground",
  title: "text-body font-semibold",
  value: "text-caption font-medium text-muted-foreground",
  // `--group-foreground` (default = muted text) so a theme sets quieter heads.
  group: "text-group text-group-foreground",
};

/**
 * Where the disclosure chevron sits, and when it shows.
 *
 * - **`lead`** (default) — before the label, always visible: the classic
 *   collapsible header, whose chevron column every title in a stack aligns on.
 * - **`trailing`** — right after the label run, and only while the row is
 *   hovered or its control has keyboard focus — the chevron is decoration,
 *   the row itself is the control. For a QUIET
 *   header whose label should start flush on the rows' own column: a group
 *   header that reads "Queue 6", with the fold affordance appearing where the
 *   pointer already is. `aria-expanded` and the click target are unchanged —
 *   only where the ink sits, and when, differs.
 *
 * - **`none`** — no chevron at all, and no box reserved for one: the label
 *   starts on the row's own padding. The row is still the disclosure control
 *   (`aria-expanded`, `aria-controls`, the click target are unchanged), so the
 *   open/closed state is carried by TONE instead of ink — a collapsed header's
 *   label is muted, an open one reads at full strength. For an INSPECTOR stack
 *   of flat, rule-divided sections, where a column of chevrons is noise.
 *
 * The reveal is the `hover-reveal` primitive's per-instance state
 * (`useHoverReveal`), not a Tailwind group: `Row` already publishes
 * `group/row-actions` for its action cluster, and a chevron keyed off that
 * group would borrow a name another primitive owns. Headers are few (one per
 * section), so the per-row state costs nothing measurable.
 */
export type SectionHeaderDisclosure = "lead" | "trailing" | "none";

/**
 * The passthrough ({@link Passthrough}) is handed straight to `Row`, which
 * routes it by DESTINATION: the row box, except the control's own attributes.
 * The `aria-expanded` / `aria-controls` written below ride that same rule, which
 * is why they reach the disclosure control whether or not the header carries
 * `actions`.
 */
export interface SectionHeaderRowProps extends Passthrough {
  /**
   * Rotates the chevron and feeds aria-expanded. Optional: when omitted, falls
   * back to the surrounding <Collapsible> context.
   */
  open?: boolean;
  /** Click handler. Optional: falls back to the collapsible context's toggle. */
  onClick?: () => void;
  /**
   * Typographic variant — see {@link SectionHeaderVariant}. Defaults to
   * `"eyebrow"`; a header showing DATA rather than a label wants `"value"`.
   */
  variant?: SectionHeaderVariant;
  /** Trailing slot (swatches / stats / headerExtra). */
  actions?: React.ReactNode;
  /**
   * `false` ⇒ a STATIC header row: no chevron, no toggle, no `aria-expanded`,
   * and not a click target at all. For a section that has nothing to expand —
   * its whole content already sits in `actions`. The chevron and the toggle
   * move together on purpose: a row that cannot open must not advertise that
   * it can. The chevron's *width* is still reserved, so titles stay on one
   * column across a stack that mixes both kinds.
   */
  collapsible?: boolean;
  /** Chevron placement — see {@link SectionHeaderDisclosure}. Default `"lead"`. */
  disclosure?: SectionHeaderDisclosure;
  className?: string;
  children: React.ReactNode;
}

/**
 * Collapsible section header row. Drop-in for the eyebrow/title
 * <CollapsibleTrigger> pattern: when rendered inside a <Collapsible>, it reads
 * open/toggle/contentId from context (deliberate deviation from the plan's
 * "explicit open" stance — the real usage is the compound <Collapsible> +
 * <CollapsibleContent> pattern, so the header must integrate with context to
 * be a clean drop-in that preserves the aria-controls a11y wiring). Pass
 * explicit `open`/`onClick` for standalone use outside a Collapsible.
 *
 * `collapsible={false}` is the same row WITHOUT the disclosure affordance — the
 * one-line section header, where the row IS the section.
 */
export function SectionHeaderRow({
  open: openProp,
  onClick: onClickProp,
  variant = "eyebrow",
  actions,
  collapsible = true,
  disclosure = "lead",
  className,
  children,
  ...rest
}: SectionHeaderRowProps) {
  const ctx = useCollapsibleContext();
  // Resting the pointer on (or focusing) the header warms its content, so the
  // click that opens it does not first pay for mounting it
  // (`CollapsibleCtx.warm`); leaving lets it go. Each collapsible path below
  // lands these after the passthrough, composed with the caller's own
  // handlers (read by name).
  type WarmHandler =
    ((e: React.SyntheticEvent<HTMLElement>) => void) | undefined;
  const warmOn =
    (warmer: keyof CollapsibleWarmHandlers, caller: WarmHandler) =>
    (e: React.SyntheticEvent<HTMLElement>) => {
      ctx?.warmHandlers[warmer]();
      caller?.(e);
    };
  const onWarmEnter = warmOn(
    "onPointerEnter",
    rest.onPointerEnter as WarmHandler,
  );
  const onWarmLeave = warmOn(
    "onPointerLeave",
    rest.onPointerLeave as WarmHandler,
  );
  const onWarmFocus = warmOn("onFocus", rest.onFocus as WarmHandler);
  const onWarmBlur = warmOn("onBlur", rest.onBlur as WarmHandler);
  const open = openProp ?? ctx?.open ?? false;
  const onClick = onClickProp ?? ctx?.toggle;
  const trailing = disclosure === "trailing";
  const lead = disclosure === "lead";
  // Called unconditionally (hooks), but only WIRED on the trailing path: a lead
  // chevron is always visible, so its row carries no reveal handlers at all and
  // renders exactly the node it always has.
  const reveal = useHoverReveal();

  if (!collapsible) {
    // No `onClick` ⇒ `Row` renders a non-interactive <div>, so the `actions`
    // stay the row's only click targets and there is no dead affordance.
    return (
      <Row
        // The chevron's BOX is kept, only its ink is dropped: a stack mixing
        // collapsible and static headers has to align on one title column, or
        // the static ones read as a different kind of card rather than the same
        // card without a body. Rendering the real `CollapsibleChevron` under
        // `invisible` (which also takes it out of the a11y tree) means the
        // spacer IS the thing it reserves space for — it cannot drift from the
        // chevron's size the way a hand-measured spacer box would.
        //
        // A trailing (or absent) disclosure has no lead column to keep, so a
        // static header in that mode reserves nothing: its label starts where a
        // collapsible header of the same mode does.
        icon={lead ? <CollapsibleChevron className="invisible" /> : undefined}
        actionsAlwaysVisible
        actions={actions}
        className={cn(VARIANT_CLASS[variant], className)}
        {...rest}
      >
        {children}
      </Row>
    );
  }

  if (trailing) {
    // The reveal handlers ride the passthrough, which `Row` routes by
    // destination: pointer enter/leave land on the row BOX (so hovering any of
    // it reveals), focus/blur on the CONTROL (so Tab reaching the header does).
    // Each is composed with a caller's own handler rather than replacing it.
    // The caller's own handlers come through the `onWarm*` composers above
    // (read by NAME off the passthrough — inspecting the bag, not diverting
    // it: the whole bag is still spread onto `Row` below, and the composed
    // handler written after it is the one that lands).
    const { groupProps } = reveal;

    return (
      <Row
        aria-expanded={open}
        aria-controls={ctx?.contentId}
        onClick={onClick}
        actionsAlwaysVisible
        actions={actions}
        className={cn(VARIANT_CLASS[variant], className)}
        {...rest}
        onPointerEnter={(e: React.PointerEvent<HTMLElement>) => {
          groupProps.onPointerEnter();
          onWarmEnter(e);
        }}
        onPointerLeave={(e: React.PointerEvent<HTMLElement>) => {
          groupProps.onPointerLeave();
          onWarmLeave(e);
        }}
        onFocus={(e) => {
          groupProps.onFocus(e);
          onWarmFocus(e);
        }}
        onBlur={(e) => {
          groupProps.onBlur(e);
          onWarmBlur(e);
        }}
      >
        {children}
        <CollapsibleChevron
          open={open}
          className={hoverRevealClass(reveal.revealed)}
        />
      </Row>
    );
  }

  if (disclosure === "none") {
    // No chevron, so TONE carries the state: the row (label and icon) is muted
    // while collapsed. The actions are re-toned to the foreground they would
    // inherit open, so a header toggle does not read as disabled just because
    // its section is shut — the tone speaks for the section, not its controls.
    // `contents` keeps the wrapper out of the actions cluster's layout.
    return (
      <Row
        aria-expanded={open}
        aria-controls={ctx?.contentId}
        onClick={onClick}
        actionsAlwaysVisible
        hover="muted"
        actions={
          actions === undefined ? undefined : open ? (
            actions
          ) : (
            <span className="contents text-foreground">{actions}</span>
          )
        }
        className={cn(
          VARIANT_CLASS[variant],
          !open && "text-muted-foreground",
          className,
        )}
        {...rest}
        onPointerEnter={onWarmEnter}
        onPointerLeave={onWarmLeave}
        onFocus={onWarmFocus}
        onBlur={onWarmBlur}
      >
        {children}
      </Row>
    );
  }

  return (
    <Row
      aria-expanded={open}
      aria-controls={ctx?.contentId}
      onClick={onClick}
      actionsAlwaysVisible
      actions={actions}
      icon={<CollapsibleChevron open={open} />}
      className={cn(VARIANT_CLASS[variant], className)}
      {...rest}
      onPointerEnter={onWarmEnter}
      onPointerLeave={onWarmLeave}
      onFocus={onWarmFocus}
      onBlur={onWarmBlur}
    >
      {children}
    </Row>
  );
}
