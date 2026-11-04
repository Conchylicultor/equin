import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { modelDisplayLabel } from "@plugins/conversations/plugins/model-provider/core";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { readManageAnswer } from "@plugins/tasks/core";
import {
  TRACK_META,
  type TaskTrack,
} from "@plugins/tasks/plugins/task-track/core";
import { Refusal, TaskChip } from "./target-chip";

type EditTaskInput = {
  task_id: string;
  title?: string;
  description?: string | null;
  add_after?: string[];
  remove_after?: string[];
  start?: "armed" | "manual";
  model?: string;
  /** Calls made before edit_task could move a task between tracks lack it. */
  track?: TaskTrack;
};

/** The edit in words, in the order the tool applies it. */
function changes(input: EditTaskInput): string[] {
  const out: string[] = [];
  if (input.title !== undefined) out.push("renamed");
  if (input.track !== undefined)
    out.push(`track: ${TRACK_META[input.track].label}`);
  if (input.description === null) out.push("description cleared");
  else if (input.description !== undefined) out.push("description rewritten");
  const added = input.add_after?.length ?? 0;
  const removed = input.remove_after?.length ?? 0;
  if (added > 0) out.push(`+${added} prerequisite${added === 1 ? "" : "s"}`);
  if (removed > 0)
    out.push(`−${removed} prerequisite${removed === 1 ? "" : "s"}`);
  if (input.start === "armed")
    out.push(
      input.model
        ? `armed to launch on ${modelDisplayLabel(input.model)}`
        : "armed to launch",
    );
  if (input.start === "manual") out.push("disarmed");
  return out;
}

export function EditTaskView({ event }: ToolRendererProps) {
  const input = event.input as EditTaskInput;
  const answer = event.result ? readManageAnswer(event.result.content) : null;
  const refused = answer?.kind === "refused";
  const changed = changes(input);
  const hasBody =
    input.title !== undefined ||
    typeof input.description === "string" ||
    (input.add_after?.length ?? 0) > 0 ||
    (input.remove_after?.length ?? 0) > 0 ||
    refused;

  return (
    <ToolCallCard
      event={event}
      aside={<TaskChip taskId={input.task_id} />}
      // The edit's words are short and are what the row is about: the rigid
      // note keeps them whole, the task chip yields beside them.
      note={changed.length > 0 ? `· ${changed.join(", ")}` : undefined}
      isError={refused || undefined}
      defaultOpen={refused}
    >
      {hasBody && (
        <Stack gap="sm">
          {refused && <Refusal message={answer.message} />}
          {input.title !== undefined && (
            <Field label="Title">
              <Text as="span">{input.title}</Text>
            </Field>
          )}
          {(input.add_after?.length ?? 0) > 0 && (
            <Field label="Now runs after">
              <Chips ids={input.add_after!} />
            </Field>
          )}
          {(input.remove_after?.length ?? 0) > 0 && (
            <Field label="No longer runs after">
              <Chips ids={input.remove_after!} />
            </Field>
          )}
          {typeof input.description === "string" && (
            <div className="prose-xs text-caption text-muted-foreground">
              <Markdown>{input.description}</Markdown>
            </div>
          )}
        </Stack>
      )}
    </ToolCallCard>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Cluster gap="sm" align="baseline">
      <Text as="span" variant="caption" tone="muted" className={rigidClass()}>
        {label}
      </Text>
      {children}
    </Cluster>
  );
}

function Chips({ ids }: { ids: readonly string[] }) {
  return (
    <>
      {ids.map((id) => (
        <TaskChip key={id} taskId={id} />
      ))}
    </>
  );
}
