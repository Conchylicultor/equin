import type { ReactNode } from "react";
import type { Session } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { countryName, flagOf, span, timeOfDay } from "../internal/format";
import { softwareLine } from "../internal/facts";
import { LANE_TRACKS, useLaneWindow } from "../internal/lane-context";
import { visitLoad } from "../internal/load";
import { JourneyBar, actionsLabel } from "./journey-bar";
import { LoadChip } from "./load-chip";

const DEVICE_ICON = {
  Desktop: symbol("computer"),
  Mobile: symbol("smartphone"),
  Tablet: symbol("tablet"),
} as const;

/**
 * One visit's row: who (flag, country, time; device, software, source;
 * first visit or returning, channel, load time) · its journey on the shared
 * axis · how long it lasted (and how much of it was active, when the stretches
 * away are recorded and there were some) and how many actions it held.
 */
export function SessionLane({ session }: { session: Session }): ReactNode {
  const journey = useLaneWindow().journeys.get(session.id);
  if (!journey)
    throw new Error(`[sessions] no journey derived for visit ${session.id}`);
  const flag = flagOf(session.country);
  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- the lane's three tracks are shared with the axis row (LANE_TRACKS), so ticks stand over bars
    <Inset x="sm" y="xsm" className={cn(LANE_TRACKS, "w-full items-center")}>
      <Stack gap="none" className={yieldClass("x")}>
        <Line className="gap-sm">
          {flag !== null && (
            <Text as="span" variant="body" aria-hidden>
              {flag}
            </Text>
          )}
          <Text variant="label" tone="strong">
            {countryName(session.country)}
          </Text>
          <Text
            as="span"
            variant="caption"
            tone="faint"
            className="tabular-nums"
          >
            {timeOfDay(session.startedAt)}
          </Text>
          {session.owner && (
            <Badge variant="primary" shape="pill">
              You
            </Badge>
          )}
          {session.live && (
            <Badge variant="success" shape="pill">
              Live
            </Badge>
          )}
        </Line>
        <Line className="gap-xs pt-2xs text-muted-foreground">
          <Icon icon={DEVICE_ICON[session.device]} className="size-[15px]" />
          <Fill>
            <Text variant="caption" tone="muted">
              {softwareLine(session)}
            </Text>
          </Fill>
        </Line>
        <Cluster gap="xs" className="pt-xsm">
          <Badge variant={session.returning ? "primary" : "muted"} shape="pill">
            {session.returning ? "Returning" : "First visit"}
          </Badge>
          <Badge variant="muted" shape="pill">
            {session.channel}
          </Badge>
          <LoadChip load={visitLoad(session)} />
        </Cluster>
      </Stack>
      <JourneyBar journey={journey} />
      <Stack gap="none" align="end">
        <Text variant="subheading" className="tabular-nums">
          {span(journey.durationS)}
        </Text>
        {journey.activeS !== null && journey.activeS < journey.durationS && (
          <Text variant="caption" tone="faint" className="tabular-nums">
            <span className="font-medium text-muted-foreground">
              {span(journey.activeS)}
            </span>{" "}
            active
          </Text>
        )}
        <Text variant="caption" tone={journey.actionCount ? "muted" : "faint"}>
          {actionsLabel(journey.actionCount)}
        </Text>
      </Stack>
    </Inset>
  );
}
