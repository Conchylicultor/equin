import type { ReactNode } from "react";
import { HOLD_SPECS } from "@plugins/infra/plugins/jobs/core";
import { useBackgroundEntry } from "@plugins/infra/plugins/background/plugins/catalog/web";
import { backgroundEntryPane } from "@plugins/debug/plugins/background/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useQueueActions } from "../internal/actions";
import { formatDuration } from "../internal/format";
import { isOverCeiling, type JobListRow } from "../internal/job-rows";
import { DurationText, HoldBadge, ProblemBadge, StatusBadge } from "./cells";
import {
  CodeBlock,
  DetailHeader,
  IdValue,
  JsonBlock,
  MetaCell,
  MetaGrid,
  Note,
  TimeCell,
} from "./detail-kit";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { RunStrip } from "./run-strip";

const playIcon = symbol("play-arrow");
const replayIcon = symbol("replay");

/**
 * One Jobs row in full, adapting to what it is: a live queue row (state,
 * attempts, run-at / lock, worker liveness, queue, priority, input, last
 * error, Retry / Cancel) or a finished run (start / finish, duration against
 * its hold class's ceiling, slot wait, attempt, input, error, Run now). Both
 * end on the job's recent-runs strip.
 */
export function JobDetail({
  row,
  followed,
  jobRows,
  runTarget,
}: {
  row: JobListRow;
  /** The opened key was a queue row that has since finished: `row` is the run it became. */
  followed: boolean;
  /** Every Jobs row of the same job name, for the strip. */
  jobRows: readonly JobListRow[];
  /** The link a bar of the recent-runs strip opens: that row's detail. */
  runTarget: (key: string) => LinkTarget;
}) {
  return (
    <Stack gap="lg">
      {row.kind === "live" ? (
        <LiveDetail row={row} />
      ) : (
        <RunDetail row={row} followed={followed} />
      )}
      <RunStrip rows={jobRows} current={row.key} runTarget={runTarget} />
    </Stack>
  );
}

function Badges({ row }: { row: JobListRow }) {
  return (
    <>
      <StatusBadge status={row.status} />
      {row.problem !== null && <ProblemBadge problem={row.problem} />}
      {row.hold !== null && <HoldBadge hold={row.hold} />}
      {row.kind === "run" && isOverCeiling(row) && (
        <Badge variant="warning">over ceiling</Badge>
      )}
    </>
  );
}

/** Opens the job's entry in Debug → Background activity (its schedule, recent runs, Run now). */
function OpenInBackground({ jobName }: { jobName: string }) {
  const openPane = useOpenPane();
  return (
    <Button
      variant="outline"
      {...openPane.link(
        backgroundEntryPane,
        { kind: "job", name: jobName },
        { mode: "push" },
      )}
    >
      Open in Background activity
    </Button>
  );
}

function LiveDetail({ row }: { row: Extract<JobListRow, { kind: "live" }> }) {
  const actions = useQueueActions();
  const { job } = row;
  const canRetry = job.state === "retrying" || job.state === "dead";
  return (
    <>
      <DetailHeader
        name={job.jobName}
        badges={<Badges row={row} />}
        buttons={
          <>
            {canRetry && (
              <Button
                variant="default"
                onClick={() => actions.retryJob(job.id)}
              >
                <Icon icon={replayIcon} className="size-4" /> Retry
              </Button>
            )}
            {job.state === "pending" && (
              <Button
                variant="destructive"
                onClick={() => actions.cancelJob(job.id)}
              >
                Cancel
              </Button>
            )}
            <OpenInBackground jobName={job.jobName} />
          </>
        }
      />
      <MetaGrid>
        <MetaCell label="ID">
          <IdValue value={job.id} />
        </MetaCell>
        <MetaCell label="Attempts">
          <Text className="tabular-nums">
            {job.attempts} of {job.maxAttempts}
          </Text>
        </MetaCell>
        <TimeCell label="Run at" date={new Date(job.runAt)} />
        {job.lockedAt !== null && (
          <TimeCell label="Locked at" date={new Date(job.lockedAt)} />
        )}
        <MetaCell label="Queue">
          <Text variant="code">{job.queueName ?? "(default)"}</Text>
        </MetaCell>
        <MetaCell label="Priority">
          <Text className="tabular-nums">{job.priority}</Text>
        </MetaCell>
        {job.lockedBy !== null && (
          <MetaCell label="Locked by">
            <IdValue value={job.lockedBy} />
          </MetaCell>
        )}
        <TimeCell label="Created" date={new Date(job.createdAt)} />
      </MetaGrid>
      <WorkerLiveness row={row} />
      <JsonBlock label="Input" value={job.input} />
      {job.lastError !== null && (
        <CodeBlock label="Last error" text={job.lastError} tone="destructive" />
      )}
    </>
  );
}

/**
 * Who holds a running row. Only meaningful while the row is locked (`alive`
 * is null otherwise). "Locked for 40 minutes" is NOT a fault on its own — a
 * long handler is expected. The fault is a locked row whose worker no longer
 * holds the job's advisory lock (`no worker`), or the opposite: a worker that
 * IS still there, passed its hold class's deadline, ignored the abort, and
 * whose slot the pool has written off (`forfeited`) — nothing was taken from
 * it, its row is untouched and its lock still held, which is what stops the
 * sweeper reclaiming it.
 */
function WorkerLiveness({
  row,
}: {
  row: Extract<JobListRow, { kind: "live" }>;
}) {
  const { job } = row;
  if (job.alive === null) return null;
  const notes: ReactNode[] = [];
  notes.push(
    job.alive ? (
      <Note key="alive">
        <Text>
          <Badge variant="success">alive</Badge> A worker holds this job&apos;s
          advisory lock.
        </Text>
      </Note>
    ) : (
      <Note key="gone" tone="destructive">
        <Text>
          <Badge variant="destructive">gone</Badge> No advisory lock on this
          job: the stuck-lock sweeper will reclaim the row (or dispatch is still
          acquiring it).
        </Text>
      </Note>
    ),
  );
  if (job.forfeited === true) {
    notes.push(
      <Note key="forfeited" tone="destructive">
        <Text>
          <Badge variant="destructive">forfeited</Badge> The worker passed its
          hold class&apos;s deadline and ignored the abort; the pool stopped
          counting its slot. The row is untouched and its lock still held, so
          the sweeper will not reclaim it.
        </Text>
      </Note>,
    );
  }
  return (
    <Stack gap="xs">
      <Text variant="label">Worker liveness</Text>
      {notes}
    </Stack>
  );
}

function RunDetail({
  row,
  followed,
}: {
  row: Extract<JobListRow, { kind: "run" }>;
  followed: boolean;
}) {
  const { run } = row;
  const ceiling = run.hold === null ? null : HOLD_SPECS[run.hold].ceilingMs;
  return (
    <>
      <DetailHeader
        name={run.jobName}
        badges={<Badges row={row} />}
        buttons={
          <>
            <RunNow jobName={run.jobName} />
            <OpenInBackground jobName={run.jobName} />
          </>
        }
      />
      {followed && (
        <Note>
          <Text>
            This job left the queue while it was open — showing the run it
            became.
          </Text>
        </Note>
      )}
      <MetaGrid>
        <TimeCell label="Started" date={run.startedAt} />
        <TimeCell label="Finished" date={run.finishedAt} />
        <MetaCell
          label="Duration"
          note={
            ceiling === null
              ? null
              : `${isOverCeiling(row) ? "over the" : "under the"} ${formatDuration(ceiling)} ceiling`
          }
        >
          <DurationText ms={run.durationMs} hold={run.hold} />
        </MetaCell>
        <MetaCell label="Waited for slot">
          <Text className="tabular-nums">
            {run.waitMs === null ? "—" : formatDuration(run.waitMs)}
          </Text>
        </MetaCell>
        <MetaCell label="Attempt">
          <Text className="tabular-nums">
            {run.maxAttempts === null
              ? run.attempt
              : `${run.attempt} of ${run.maxAttempts}`}
          </Text>
        </MetaCell>
        <MetaCell label="Run">
          <Text className="tabular-nums">#{run.seq}</Text>
        </MetaCell>
        {run.jobId !== null && (
          <MetaCell label="Job id">
            <IdValue value={run.jobId} />
          </MetaCell>
        )}
        {run.queuedAt !== null && (
          <TimeCell label="Queued at" date={run.queuedAt} />
        )}
      </MetaGrid>
      {run.input !== null && run.input !== undefined && (
        <JsonBlock label="Input" value={run.input} />
      )}
      {run.error !== null && (
        <CodeBlock label="Error" text={run.error} tone="destructive" />
      )}
    </>
  );
}

/**
 * Run now — offered only where the Background catalog says the job can be run
 * on demand (a scheduled job); the endpoint refuses any other.
 */
function RunNow({ jobName }: { jobName: string }) {
  const actions = useQueueActions();
  const entry = useBackgroundEntry("job", jobName);
  if (entry.status !== "ready" || entry.data === null) return null;
  if (!entry.data.canRunNow) return null;
  return (
    <Button variant="default" onClick={() => actions.runJobNow(jobName)}>
      <Icon icon={playIcon} className="size-4" /> Run now
    </Button>
  );
}
