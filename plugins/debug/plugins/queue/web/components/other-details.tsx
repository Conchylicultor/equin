import type { DeadJobRow } from "@plugins/infra/plugins/jobs/core";
import type {
  EmissionListRow,
  TriggerRow,
} from "@plugins/infra/plugins/events/core";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useQueueActions } from "../internal/actions";
import { JobBadge } from "./cells";
import {
  CodeBlock,
  DetailHeader,
  DetailSection,
  IdValue,
  JsonBlock,
  MetaCell,
  MetaGrid,
  Note,
  TimeCell,
} from "./detail-kit";
import { MatchedBadge } from "./events-view";
import { TriggerFilters } from "./triggers-view";

/** One archived dead job: when it died, its attempts, input and last error. */
export function DeadJobDetail({ job }: { job: DeadJobRow }) {
  return (
    <Stack gap="lg">
      <DetailHeader
        name={job.jobName}
        badges={
          <Badge
            variant="destructive"
            icon={<StatusDot colorClass="bg-destructive" />}
          >
            Dead
          </Badge>
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
        {job.diedAt !== null ? (
          <TimeCell label="Died at" date={job.diedAt} />
        ) : (
          <MetaCell label="Died at">
            <Text tone="muted">(unknown)</Text>
          </MetaCell>
        )}
        <TimeCell label="Archived at" date={job.archivedAt} />
      </MetaGrid>
      <JsonBlock label="Input" value={job.input} />
      {job.lastError !== null && (
        <CodeBlock label="Last error" text={job.lastError} tone="destructive" />
      )}
    </Stack>
  );
}

/**
 * One emission: when, which triggers it reached (each named with the job it
 * runs, when that trigger still exists), and its payload.
 */
export function EmissionDetail({
  emission,
  triggers,
}: {
  emission: EmissionListRow;
  /** The live triggers, to name each matched id's job; `null` while loading. */
  triggers: readonly TriggerRow[] | null;
}) {
  const byId = new Map((triggers ?? []).map((t) => [t.id, t]));
  return (
    <Stack gap="lg">
      <DetailHeader
        name={emission.eventName}
        badges={<MatchedBadge count={emission.matchedCount} />}
      />
      <MetaGrid>
        <MetaCell label="Emission id">
          <IdValue value={emission.id} />
        </MetaCell>
        <TimeCell label="Emitted at" date={emission.emittedAt} />
      </MetaGrid>
      <DetailSection
        label="Matched triggers"
        count={String(emission.matchedTriggerIds.length)}
      >
        {emission.matchedTriggerIds.length === 0 ? (
          <Note tone="destructive">
            <Text>No trigger matched this emission, so nothing ran.</Text>
          </Note>
        ) : (
          <Cluster gap="xs">
            {emission.matchedTriggerIds.map((id) => {
              const trigger = byId.get(id);
              return (
                <Badge key={id} mono tooltip={id}>
                  {trigger === undefined ? id : `${id} → ${trigger.jobName}`}
                </Badge>
              );
            })}
          </Cluster>
        )}
      </DetailSection>
      <JsonBlock label="Payload" value={emission.payload} />
    </Stack>
  );
}

/** One trigger: its event, job, filters, input template and lifecycle, with Enable/Disable and Delete. */
export function TriggerDetail({ trigger }: { trigger: TriggerRow }) {
  const actions = useQueueActions();
  return (
    <Stack gap="lg">
      <DetailHeader
        name={trigger.eventName}
        badges={
          <>
            {trigger.enabled ? (
              <Badge variant="success">enabled</Badge>
            ) : (
              <Badge>disabled</Badge>
            )}
            {trigger.dangling && <Badge variant="destructive">dangling</Badge>}
            {trigger.oneShot && <Badge variant="info">one-shot</Badge>}
          </>
        }
        buttons={
          <>
            <Button
              variant={trigger.enabled ? "outline" : "default"}
              onClick={() =>
                actions.setTriggerEnabled(trigger.id, !trigger.enabled)
              }
            >
              {trigger.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              variant="destructive"
              onClick={() => actions.deleteTrigger(trigger.id)}
            >
              Delete
            </Button>
          </>
        }
      />
      {trigger.dangling && (
        <Note tone="destructive">
          <Text>
            The target job is no longer registered, so this trigger can never
            deliver. The boot sweep deletes dangling triggers; delete it now or
            restore the job.
          </Text>
        </Note>
      )}
      <MetaGrid>
        <MetaCell label="Trigger id">
          <IdValue value={trigger.id} />
        </MetaCell>
        <MetaCell label="Event">
          <Text variant="code">{trigger.eventName}</Text>
        </MetaCell>
        <MetaCell label="Job">
          <JobBadge name={trigger.jobName} />
        </MetaCell>
        <MetaCell label="One-shot">
          <Text>
            {trigger.oneShot ? "Yes — removed after its first match" : "No"}
          </Text>
        </MetaCell>
        <TimeCell label="Created" date={new Date(trigger.createdAt)} />
      </MetaGrid>
      <DetailSection label="Filters">
        <TriggerFilters filters={trigger.filters} />
      </DetailSection>
      <JsonBlock label="Job input (jobWith)" value={trigger.jobWith} />
    </Stack>
  );
}
