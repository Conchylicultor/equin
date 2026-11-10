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
import { axisFrac, axisTicks } from "../internal/axis";
import { LANE_TRACKS, LaneWindowContext } from "../internal/lane-context";
import { GAP_KINDS } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { GAP_LABEL, GapSwatch } from "./gap-look";

/**
 * The Sessions list's band: the search, the surface's actions (the shape
 * switch, then the summary pushed right) — and,
 * under them, the axis row whose ticks stand over every journey. One sticky
 * band, so the axis stays on screen while the visits scroll under it.
 * No view controls: the surface pins its one view (newest first, by day), and
 * which visits show is the server's question (range, shape), asked above.
 */
function SessionsToolbar({ search, actions }: ToolbarParts): ReactNode {
  return (
    <Stack gap="none" className="rail-follow">
      <Line className="gap-smd py-smd">
        <div className="w-[260px]">{search}</div>
        {/* eslint-disable-next-line row-actions/no-raw-actions-slot -- surface-level toolbar actions, one per DataView, not a per-row cluster */}
        {actions}
      </Line>
      <AxisRow />
    </Stack>
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
  forms: { search: "field", controls: "ghost", creators: "labelled" },
  component: SessionsToolbar,
};
