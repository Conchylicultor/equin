import { useContext, type ReactNode } from "react";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Placed,
  pct,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import type {
  ToolbarArrangement,
  ToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import { PillsToolbar } from "@plugins/primitives/plugins/data-view/web";
import { axisFrac, axisTicks } from "../internal/axis";
import { LANE_TRACKS, LaneWindowContext } from "../internal/lane-context";
import { GAP_KINDS } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { GAP_LABEL, GapSwatch } from "./gap-look";
import { span } from "../internal/format";
import { seconds } from "../internal/load";

/**
 * The Sessions list's band: the summary on its own line, then the standard
 * DataView toolbar (`PillsToolbar`: the views — All, With actions, 2+ pages,
 * Bounced, each a saved filter — and the tools pill: search, Filter / Sort /
 * View; the quick filters — whose visits, which device — on the row under
 * it) — and, under them, the axis row whose ticks stand over every journey.
 * One sticky band, so the axis stays on screen while the visits scroll under
 * it.
 */
function SessionsToolbar(parts: ToolbarParts): ReactNode {
  return (
    <Stack gap="none" className="rail-follow pt-smd">
      <Summary />
      <PillsToolbar {...parts} className="pb-smd" />
      <AxisRow />
    </Stack>
  );
}

/** How many visits the view matches, and figures over the loaded ones. */
function Summary(): ReactNode {
  const lane = useContext(LaneWindowContext);
  if (lane === null || lane.summary === null) return null;
  const { total, loaded, medianS, medianLoadMs, withActions } = lane.summary;
  return (
    <Line className="gap-md pb-xsm">
      <Text variant="caption" tone="muted">
        <Strong>{total ?? `${loaded}+`}</Strong> sessions
      </Text>
      {medianS !== null && (
        <Text variant="caption" tone="muted">
          median <Strong>{span(medianS)}</Strong>
        </Text>
      )}
      {medianLoadMs !== null && (
        <Text variant="caption" tone="muted">
          median load <Strong>{seconds(medianLoadMs, 1)}</Strong>
        </Text>
      )}
      <Text variant="caption" tone="muted">
        <Strong>{withActions}</Strong> with actions
      </Text>
    </Line>
  );
}

/** A figure inside a summary phrase: inline, so the phrase stays one line. */
function Strong({ children }: { children: ReactNode }): ReactNode {
  return (
    <b className="font-semibold text-foreground tabular-nums">{children}</b>
  );
}

/**
 * The shared axis' labelled ticks, in the lanes' own tracks, with the key to
 * the stretches away beside them — the inline
 * inset is the rows': a card's hairline, the row's padding, the lane's own.
 */
function AxisRow(): ReactNode {
  const lane = useContext(LaneWindowContext);
  if (lane === null) return null;
  const ticks = axisTicks(lane.axisMaxS);
  // The rows' own nesting, mirrored: the card's hairline (a transparent
  // border), the row's padding, the lane's inset — so the tracks line up.
  return (
    // eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794239361-kagy27): a hand-rolled rule strip mirroring the rows' geometry; a Band once its card owns the inset
    <div className="border-x border-b border-transparent border-b-border/60 px-row">
      <Inset
        x="sm"
        t="2xs"
        b="xsm"
        // The lane's shared tracks (LANE_TRACKS), so each tick stands over the bars.
        className={LANE_TRACKS}
      >
        {/* The key to the bars' stretches away, in the facts column. */}
        <Line className="gap-md">
          {GAP_KINDS.map((k) => (
            <Line key={k} className="gap-xsm">
              <GapSwatch kind={k} className="h-[9px] w-4 rounded-xs" />
              <Text as="span" variant="caption" tone="faint">
                {GAP_LABEL[k].legend}
              </Text>
            </Line>
          ))}
        </Line>
        <div className="relative h-4">
          {ticks.map((t, i) => (
            <Placed
              key={t.s}
              x={
                i === 0
                  ? { start: 0 }
                  : { center: pct(axisFrac(t.s, lane.axisMaxS)) }
              }
              y={{ start: 0 }}
            >
              <Text
                variant="caption"
                tone="faint"
                className="whitespace-nowrap tabular-nums"
              >
                {t.label}
              </Text>
            </Placed>
          ))}
        </div>
        <span />
      </Inset>
    </div>
  );
}

/** The Sessions list's toolbar arrangement — a value the surface passes, not a contribution. */
export const sessionsToolbar: ToolbarArrangement = {
  id: "deploy-sessions",
  // The default bar's forms: the search a quiet well inside the tools pill.
  forms: { search: "filled", controls: "ghost", creators: "labelled" },
  component: SessionsToolbar,
};
