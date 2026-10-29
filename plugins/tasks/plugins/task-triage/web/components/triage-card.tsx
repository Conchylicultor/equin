import type { ReactElement } from "react";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { FieldOptionMeta } from "@plugins/fields/core";
import {
  TRIAGE_PRIORITY_META,
  TRIAGE_RISK_META,
  TRIAGE_STALE_REASON_META,
  TRIAGE_TASK_TYPE_META,
  TRIAGE_VERDICT_META,
  type TriageRead,
  type TriageReadResult,
} from "../../core";
import {
  useAnswerTriage,
  useRunTriage,
  useTriageRead,
} from "../internal/use-triage";
import { ApproveFooter } from "./approve-footer";
import { OptionBadge } from "./option-badge";
import { ConversationButton } from "./triage-header";
import { TriageNote } from "./triage-note";

const runIcon = symbol("play-arrow");
const rerunIcon = symbol("replay");
const warningIcon = symbol("warning");

/**
 * The Triage card's body: the read in whatever state it is in, the person's
 * note for it, and the Approve footer — which stands on its own, so a task is
 * approvable whether or not triage ever ran.
 */
export function TriageCard({ taskId }: { taskId: string }): ReactElement {
  return (
    <Stack gap="md">
      <TriageBody taskId={taskId} />
      <TriageNote taskId={taskId} />
      <ApproveFooter taskId={taskId} />
    </Stack>
  );
}

function TriageBody({ taskId }: { taskId: string }): ReactElement {
  const read = useTriageRead(taskId);
  switch (read.status) {
    case "loading":
      return <Loading variant="rows" count={3} />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the triage"
          error={read.error}
          refetch={read.refetch}
        />
      );
    case "ready":
      return <StateBody taskId={taskId} read={read.data} />;
  }
}

function StateBody({
  taskId,
  read,
}: {
  taskId: string;
  read: TriageRead | null;
}): ReactElement {
  const run = useRunTriage(taskId);
  if (read === null) {
    return (
      <Stack gap="sm" align="start">
        <Text as="p" variant="body" tone="muted">
          Have an agent read this task against the code and suggest a verdict,
          priority, type and risk before you decide.
        </Text>
        <Button variant="outline" onClick={run}>
          <Icon icon={runIcon} />
          Run triage
        </Button>
      </Stack>
    );
  }
  switch (read.state) {
    case "queued":
    case "running":
      return (
        <Stack gap="xs">
          <Text as="p" variant="caption" tone="muted">
            {read.state === "queued"
              ? "Waiting for a free slot…"
              : "An agent is reading the task…"}
          </Text>
          <Loading variant="rows" count={3} />
        </Stack>
      );
    case "failed":
      return (
        <Stack gap="md">
          <Stack direction="row" gap="sm" align="center">
            <Fill>
              <Text variant="body" tone="destructive">
                {`Triage failed: ${read.error}`}
              </Text>
            </Fill>
            {read.conversationId !== null ? (
              <span className={rigidClass()}>
                <ConversationButton conversationId={read.conversationId} />
              </span>
            ) : null}
            <Button variant="outline" onClick={run} className={rigidClass()}>
              <Icon icon={rerunIcon} />
              Re-run
            </Button>
          </Stack>
          {read.previous !== null ? (
            <ReadView taskId={taskId} read={read.previous} dim />
          ) : null}
        </Stack>
      );
    case "stale":
      return (
        <Stack gap="md">
          <Stack
            direction="row"
            gap="sm"
            align="center"
            className="rounded-md border border-warning/50 bg-warning/10 px-md py-sm text-warning"
          >
            <Icon icon={warningIcon} className={rigidClass()} />
            <Fill>
              <Text variant="body">
                {`This triage may be out of date: ${STALE_WORDS[read.staleReason]}`}
              </Text>
            </Fill>
            <Button variant="outline" onClick={run} className={rigidClass()}>
              <Icon icon={rerunIcon} />
              Re-run
            </Button>
          </Stack>
          <ReadView taskId={taskId} read={read.read} dim />
        </Stack>
      );
    case "done":
      return <ReadView taskId={taskId} read={read.read} dim={false} />;
  }
}

/** Why a stale read is stale, as the notice says it. */
const STALE_WORDS = {
  old: "it is older than the stale-after setting.",
  edited: "the task was edited after it ran.",
} as const satisfies Record<keyof typeof TRIAGE_STALE_REASON_META, string>;

/**
 * A read: the four-cell stats row (Verdict · Priority · Type · Risk), the
 * summary, and the question with its one-click answers. `dim` greys a read
 * that no longer describes the task (stale, or the last one before a failed
 * re-run).
 */
function ReadView({
  taskId,
  read,
  dim,
}: {
  taskId: string;
  read: TriageReadResult;
  dim: boolean;
}): ReactElement {
  return (
    <Stack gap="md" className={cn(dim && "opacity-60")}>
      <Grid as="dl" cols={4} gap="sm">
        <Stat label="Verdict" meta={TRIAGE_VERDICT_META[read.verdict]} />
        <Stat label="Priority" meta={TRIAGE_PRIORITY_META[read.priority]} />
        <Stat label="Type" meta={TRIAGE_TASK_TYPE_META[read.taskType]} />
        <Stat label="Risk" meta={TRIAGE_RISK_META[read.risk]} />
      </Grid>
      <Stack gap="xs">
        <Text as="p" variant="eyebrow" tone="muted">
          Summary
        </Text>
        <Markdown>{read.context}</Markdown>
        {read.areas.length > 0 ? (
          <Text as="p" variant="caption" tone="muted">
            {`Areas: ${read.areas.join(", ")}`}
          </Text>
        ) : null}
      </Stack>
      {read.question !== null ? (
        <TriageQuestion
          taskId={taskId}
          question={read.question}
          answers={read.answers}
          answer={read.answer}
        />
      ) : null}
    </Stack>
  );
}

function Stat({
  label,
  meta,
}: {
  label: string;
  meta: FieldOptionMeta;
}): ReactElement {
  return (
    <Stack gap="2xs" align="start">
      <Text as="dt" variant="eyebrow" tone="muted">
        {label}
      </Text>
      <dd>
        <OptionBadge meta={meta} />
      </dd>
    </Stack>
  );
}

/**
 * Triage's one question, answered in a click (again to clear it). The answer
 * goes to the agent; it approves nothing.
 */
function TriageQuestion({
  taskId,
  question,
  answers,
  answer,
}: {
  taskId: string;
  question: string;
  answers: readonly string[];
  answer: string | null;
}): ReactElement {
  const pick = useAnswerTriage(taskId);
  return (
    <Stack gap="xs">
      <Text as="p" variant="label">
        {question}
      </Text>
      <Cluster gap="xs">
        {answers.map((a) => (
          <ToggleChip
            key={a}
            active={answer === a}
            onClick={() => pick(answer === a ? null : a)}
          >
            {a}
          </ToggleChip>
        ))}
      </Cluster>
    </Stack>
  );
}
