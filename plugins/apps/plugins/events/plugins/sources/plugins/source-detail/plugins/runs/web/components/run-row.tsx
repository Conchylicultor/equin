import type { ReactElement } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import type { EventSourceRun } from "@plugins/apps/plugins/events/plugins/events-core/core";
import {
  RUN_OUTCOME_LABEL,
  RUN_OUTCOME_VARIANT,
  describeRun,
  formatDuration,
} from "@plugins/apps/plugins/events/plugins/sources/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const warningIcon = symbol("warning");

/**
 * One run: outcome chip, the human sentence, duration, and when it started.
 *
 * `unchanged` runs are rendered exactly like the others — they are the answer to
 * "why did nothing happen", and hiding or dimming them away is what makes a
 * working cache look like a broken source.
 */
export function RunRow({ run }: { run: EventSourceRun }): ReactElement {
  const duration = formatDuration(run.durationMs);
  const caveats = run.flags.length;
  return (
    <Fill>
      <Line className="gap-sm">
        <Badge variant={RUN_OUTCOME_VARIANT[run.outcome]}>
          {RUN_OUTCOME_LABEL[run.outcome]}
        </Badge>
        {/* Only when the extraction actually reported something it could not
            express. A run with no caveats renders nothing at all — a "0 caveats"
            chip on every healthy row would turn the good outcome into noise and
            train the eye to skip the one row that matters. The count only; the
            text is long free-form model prose and lives in the run pane. */}
        {caveats > 0 && (
          <Badge
            variant="warning"
            icon={<Icon icon={warningIcon} />}
            tooltip="The extraction reported schedules it could not express"
          >
            {caveats}
          </Badge>
        )}
        <Fill>
          <Text variant="caption" tone="muted">
            {describeRun(run)}
          </Text>
        </Fill>
        {duration && (
          <Text variant="caption" tone="muted">
            {duration}
          </Text>
        )}
        <Text variant="caption" tone="muted">
          <RelativeTime date={run.startedAt} />
        </Text>
      </Line>
    </Fill>
  );
}
