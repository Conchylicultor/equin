import type { ReactElement } from "react";
import {
  mapRow,
  useLiveMutation,
  useLiveRow,
} from "@plugins/network/plugins/live/web";
import { useEditableField } from "@plugins/primitives/plugins/editable-field/web";
import { ResourceView } from "@plugins/primitives/plugins/live-state/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Textarea } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useRegisterFlush } from "@plugins/tasks/plugins/task-detail/web";
import {
  setTriageNoteEndpoint,
  taskTriageNotes,
  type TaskTriageNoteRow,
} from "../../core";

// Stable (module-level): a task without a note row has none.
function noteOf(row: TaskTriageNoteRow | null): string {
  return row?.note ?? "";
}

/**
 * The person's note about the task, fed to every triage run of it (and the
 * autopilot's launch prompt). Autosaved; a blank note deletes it. Waits for the
 * stored note before showing the field — seeding it from a not-yet-loaded ""
 * and letting the person type would race the real note in.
 */
export function TriageNote({ taskId }: { taskId: string }): ReactElement {
  const row = useLiveRow(taskTriageNotes, taskId);
  const note = mapRow(row, noteOf);
  return (
    <ResourceView resource={note}>
      {(value) => <NoteField taskId={taskId} note={value} />}
    </ResourceView>
  );
}

function NoteField({
  taskId,
  note,
}: {
  taskId: string;
  note: string;
}): ReactElement {
  const save = useLiveMutation(setTriageNoteEndpoint);
  const field = useEditableField({
    value: note,
    label: "Triage note",
    onSave: (next) => {
      save.mutate({ params: { taskId }, body: { note: next } });
    },
  });
  // The detail pane flushes every section's pending edit before it acts on the
  // task (Launch), so a note typed a moment before is never left unsaved.
  // `flush` is stable, so the registration is made once.
  useRegisterFlush(field.flush);
  return (
    // The label wraps its field, so the words name the textarea.
    <Stack as="label" gap="xs">
      <Text variant="eyebrow" tone="muted">
        Note for the agent
      </Text>
      <Textarea
        rows={2}
        fitContent
        placeholder="Constraints, context triage missed, where to start…"
        value={field.value}
        onChange={(e) => field.onChange(e.target.value)}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
      />
    </Stack>
  );
}
