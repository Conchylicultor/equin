import type { CSSProperties, ReactNode } from "react";
import {
  cn,
  ControlSizeProvider,
  Separator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import type { ToolbarParts } from "../../../core";

/** Where a pill row sits, and whether its band is click-through. */
export interface PillsLayoutProps {
  /**
   * The band under the pills is click-through (an `overlay` arrangement): each
   * pill opts back into pointer events, so the view between them stays
   * reachable. Default `false` (an in-flow band).
   */
  overlay?: boolean;
  /** The row's own inset — the arrangement's. Default `"py-sm rail-follow"`
   *  (the in-flow band: on the rail, a small gap above and below). */
  className?: string;
  /** Inline style for the row (an inset computed from the aside's reach). */
  style?: CSSProperties;
}

/**
 * One floating pill (`Surface level="float"`), interactive over a
 * click-through band when `overlay`. `give` makes it the cell that yields
 * (and scrolls its content sideways) when the row runs out of room; every
 * other pill is rigid. `className` lands on the pill's surface (a reveal
 * class, for a pill that is hidden at rest).
 */
export function ToolbarPill(props: {
  overlay?: boolean;
  give?: boolean;
  label: string;
  className?: string;
  children: ReactNode;
}): ReactNode {
  const { overlay = false, give = false, label, className, children } = props;
  const sizing = give ? yieldClass("x") : rigidClass();
  const body = give ? (
    // Past its room the strip scrolls sideways inside the pill rather than
    // pushing the tools pill off the row. Scrollbar hidden — an overflow
    // escape hatch, not a permanent affordance.
    <Scroll axis="x" hideScrollbar>
      <Line className="gap-2xs">{children}</Line>
    </Scroll>
  ) : (
    <Line className="gap-2xs">{children}</Line>
  );
  const surface = (
    <Surface
      level="float"
      role="group"
      aria-label={label}
      className={cn("p-2xs", !overlay && sizing, className)}
    >
      {body}
    </Surface>
  );
  return overlay ? (
    <Overlay.Interactive className={sizing}>{surface}</Overlay.Interactive>
  ) : (
    surface
  );
}

/**
 * The two-pill row every DataView toolbar is drawn as — wide and in the
 * compact fold alike: `[lead] [views pill] [fill] [tools pill]`. Both pills
 * are floating surfaces at ONE control size (`sm`), so they are the same
 * height and centred on one line at every width; the views pill is the one
 * cell that gives (it scrolls sideways), the row never wraps.
 *
 * `views` / `tools` `null` ⇒ that pill is not drawn at all (no empty pill).
 * `trailing` is a ready-made node in the tools pill's place, for a caller
 * that builds the pill itself (the compact fold's revealed-on-hover pill).
 */
export function PillsRow(
  props: PillsLayoutProps & {
    lead?: ReactNode;
    views: ReactNode;
    tools: ReactNode;
    trailing?: ReactNode;
  },
): ReactNode {
  const {
    overlay = false,
    className = "py-sm rail-follow",
    style,
    lead,
    views,
    tools,
    trailing,
  } = props;
  return (
    <ControlSizeProvider size="sm">
      <Line className={cn("gap-sm", className)} style={style}>
        {/* Over a click-through band there is no band surface for a bare
            title to sit on (a map shows through), so it rides the views
            pill; in flow it reads on the band, before the pill. */}
        {overlay ? null : lead}
        {views == null && !(overlay && lead) ? null : (
          <ToolbarPill overlay={overlay} give label="Views">
            {overlay ? lead : null}
            {views}
          </ToolbarPill>
        )}
        {/* The slack between the pills — click-through over an overlay band. */}
        <Fill />
        {tools == null ? null : (
          <ToolbarPill overlay={overlay} label="Tools">
            {tools}
          </ToolbarPill>
        )}
        {trailing}
      </Line>
    </ControlSizeProvider>
  );
}

/**
 * The thin rule between the tools pill's controls and its create
 * affordance: a 20px box the line centres, the rule stretching to fill it (a
 * fixed-height rule would itself be the flex item, where the vertical
 * Separator's own `self-stretch` pins it to the top).
 */
export function PillDivider(): ReactNode {
  return (
    <Center axis="horizontal" className={cn("h-5 px-2xs", rigidClass())}>
      <Separator orientation="vertical" />
    </Center>
  );
}

export type PillsToolbarProps = ToolbarParts & PillsLayoutProps;

/**
 * The DataView toolbar's wide layout: one row of
 *
 *     [title] [views pill: the editable switcher strip, "+" always shown]
 *     ··· [tools pill: search · controls · actions | create]
 *
 * the default (`barArrangement`) and the floating arrangement
 * (`floating-toolbar`, `overlay`) alike — they differ only in the row's inset
 * and whether the band under it is click-through. A pinned surface (no
 * switcher) draws no views pill.
 */
export function PillsToolbar({
  title,
  switcher,
  search,
  controls,
  actions,
  creators,
  overlay,
  className,
  style,
}: PillsToolbarProps): ReactNode {
  const hasCreators = creators != null && creators !== false;
  return (
    <PillsRow
      overlay={overlay}
      className={className}
      style={style}
      lead={title}
      views={switcher.strip}
      tools={
        <>
          {search}
          {controls}
          {/* eslint-disable-next-line row-actions/no-raw-actions-slot -- surface-level toolbar actions, one per DataView, not a per-row cluster */}
          {actions}
          {hasCreators ? (
            <>
              <PillDivider />
              {creators}
            </>
          ) : null}
        </>
      }
    />
  );
}
