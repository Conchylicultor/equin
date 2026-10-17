import type { ReactElement } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { formatDuration } from "@plugins/debug/plugins/profiling/web";
import { HighlightedCode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { traceDetailPane } from "@plugins/debug/plugins/trace/plugins/pane/web";
import type { TimelineEvent, TimelineSeverity } from "../../core";
import { sourceColorClass } from "../internal/view-model";
import { formatWallclock } from "../internal/ticks";
import { symbol } from "@plugins/ui/plugins/icons/core";

const closeIcon = symbol("close");

const SEVERITY_VARIANT: Record<
  TimelineSeverity,
  "info" | "warning" | "destructive"
> = {
  info: "info",
  warning: "warning",
  error: "destructive",
};

/**
 * The compact detail area for a clicked timeline bar: identity chips + label,
 * wall-clock extent, the source row's detail JSON, and the trace deep-link
 * when the event carries a traceId. Mounted as the view Column's footer.
 */
export function DetailStrip({
  event,
  onClose,
}: {
  event: TimelineEvent;
  onClose: () => void;
}): ReactElement {
  const openPane = useOpenPane();
  const durationMs = event.endMs - event.startMs;
  const hasDetail = Object.keys(event.detail).length > 0;
  const traceId = event.traceId;
  return (
    <Inset x="md" y="sm" className="border-t bg-muted/50">
      <Stack gap="xs">
        <Line className="gap-sm">
          <Badge variant={SEVERITY_VARIANT[event.severity]}>
            {event.severity}
          </Badge>
          <Badge
            variant="muted"
            mono
            icon={<StatusDot colorClass={sourceColorClass(event.source)} />}
          >
            {event.source}
          </Badge>
          <Badge variant="muted" mono tooltip={event.worktree}>
            {event.worktree}
          </Badge>
          <Fill>
            <Text
              as="span"
              variant="caption"
              className="font-mono font-medium"
              title={event.label}
            >
              {event.label}
            </Text>
          </Fill>
          {traceId !== undefined && (
            <Button
              variant="outline"
              {...openPane.link(
                traceDetailPane,
                { id: traceId },
                { mode: "push" },
              )}
            >
              Open trace
            </Button>
          )}
          <IconButton
            icon={closeIcon}
            label="Close details"
            onClick={onClose}
          />
        </Line>
        <Text as="div" variant="caption" tone="muted" className="tabular-nums">
          {formatWallclock(event.startMs, { seconds: true })} →{" "}
          {formatWallclock(event.endMs, { seconds: true })} ·{" "}
          {formatDuration(durationMs)}
        </Text>
        {hasDetail && (
          <Scroll axis="y" className="max-h-48">
            <HighlightedCode
              code={JSON.stringify(event.detail, null, 2)}
              lang="json"
            />
          </Scroll>
        )}
      </Stack>
    </Inset>
  );
}
