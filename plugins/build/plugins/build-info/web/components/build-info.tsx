import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { buildHistory, type BuildRun } from "@plugins/build/core";
import { BuildStatusBadge } from "@plugins/build/plugins/build-status/web";
import { buildStatusOf } from "@plugins/build/plugins/build-status/core";
import {
  buildRunTermination,
  describeTermination,
  type BuildTermination,
} from "@plugins/build/plugins/build-termination/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";

function formatDuration(start: Date, end: Date | null): string {
  const ms = (end ?? new Date()).getTime() - start.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Stack direction="row" gap="lg" align="baseline" justify="between">
      <Text
        as="span"
        variant="caption"
        className={cn(rigidClass(), "text-muted-foreground")}
      >
        {label}
      </Text>
      <Text as="span" variant="body">
        {children}
      </Text>
    </Stack>
  );
}

/**
 * How this run was ended from outside, for the two statuses where that is the
 * whole story — `killed` (a catchable signal reached the build) and
 * `interrupted` (its owner was hard-killed).
 *
 * Its own component so the live read is not called from `BuildInfo`, which
 * returns early while the run loads. The read is gated on the status (a `null`
 * tuple reads nothing), so the overwhelmingly common healthy run costs no
 * subscription.
 *
 * It renders nothing only when there is genuinely nothing to say — for any
 * killed run it prints a line even when the sender is unknown, because silence
 * here reads as "nothing killed it", which is the exact ambiguity this feature
 * exists to remove.
 */
function TerminationDetail({ run }: { run: BuildRun }) {
  const status = buildStatusOf(run);
  const externallyEnded = status === "killed" || status === "interrupted";
  const result = useLive(
    buildRunTermination,
    externallyEnded ? { id: run.id } : null,
  );
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="how this run ended"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  // `null` is `describeTermination`'s "not loaded": while the record is in
  // flight — or cannot be read on this host — it claims no sender either way.
  let record: BuildTermination | null;
  switch (result.status) {
    case "ready":
      record = result.data;
      break;
    case "loading":
    case "unavailable":
      record = null;
      break;
  }
  const described = describeTermination(status, run.exitCode, record);
  if (!described) return null;

  return (
    <Stack gap="2xs">
      <Text as="span" variant="caption" className="text-muted-foreground">
        {status === "killed" ? "Signal" : "Termination"}
      </Text>
      {/* A flow container, not a Row: the attribution carries a full ancestry
          chain and must wrap onto as many lines as it needs rather than
          ellipsize away the very pids it exists to name. */}
      <Text as="p" variant="body">
        {described.headline}
      </Text>
      {result.status === "unavailable" ? (
        <Text as="p" variant="caption" className="text-muted-foreground">
          {result.message}
        </Text>
      ) : (
        described.note !== null && (
          <Text as="p" variant="caption" className="text-muted-foreground">
            {described.note}
          </Text>
        )
      )}
    </Stack>
  );
}

export function BuildInfo({ runId }: { runId: string }) {
  // One row of the history by id — the point read, so a run older than the
  // newest 50 the window holds is still found. `found: false` means this
  // namespace has no such run.
  const result = useLiveRow(buildHistory, runId);
  if (result.status === "loading") return <Loading />;
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="this build run"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  if (!result.found) {
    return (
      <Text as="p" variant="caption" className="text-muted-foreground">
        Run not found
      </Text>
    );
  }
  const run = result.row;

  return (
    <Stack gap="md">
      <Stack direction="row" align="center" gap="sm">
        <BuildStatusBadge run={run} />
        <Badge variant={run.trigger === "auto" ? "info" : "muted"}>
          {run.trigger}
        </Badge>
      </Stack>

      <Stack gap="sm">
        <Row label={run.targets.length > 1 ? "Targets" : "Target"}>
          <Inline gap="2xs">
            {run.targets.map((t) => (
              <Badge
                key={t}
                variant={t === MAIN_COMPOSITION_ID ? "muted" : "info"}
              >
                {t}
              </Badge>
            ))}
          </Inline>
        </Row>
        {run.commitHash && (
          <Row label="Commit">
            <code className="text-code">{run.commitHash.slice(0, 8)}</code>
          </Row>
        )}
        <Row label="Started">
          <RelativeTime date={run.startedAt} />
        </Row>
        {run.finishedAt && (
          <Row label="Finished">
            <RelativeTime date={run.finishedAt} />
          </Row>
        )}
        <Row label="Duration">
          <span className="tabular-nums">
            {formatDuration(run.startedAt, run.finishedAt)}
          </span>
        </Row>
      </Stack>

      <TerminationDetail run={run} />
    </Stack>
  );
}
