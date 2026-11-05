import { useCallback, useState, type ReactElement } from "react";
import { fieldsToZodObject } from "@plugins/fields/core";
import { getEndpointErrorMessage } from "@plugins/infra/plugins/endpoints/web";
import { useOpenDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import {
  Button,
  DialogDescription,
  DialogTitle,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useCreateEventSource } from "@plugins/apps/plugins/events/plugins/events-core/web";
import {
  REFRESH_CADENCES,
  type RefreshCadence,
} from "@plugins/apps/plugins/events/plugins/events-core/core";
import type { EventSourceTypeContribution } from "../internal/source-types";
import { initialConfigValues } from "../internal/config-values";
import { CADENCE_LABEL } from "../internal/format";
import { SourceConfigForm } from "./source-config-form";

const CADENCE_SEGMENTS = REFRESH_CADENCES.map((id) => ({
  id,
  label: CADENCE_LABEL[id],
}));

/**
 * The add-source dialog opener of this surface: opens it for one registered
 * source type, in the surface's render origin.
 *
 * A dialog rather than a `.../new` sentinel route (the `deploy/servers` shape)
 * because the type is chosen BEFORE the form exists: a route would have to carry
 * the type id as a second param and reserve a sentinel id, and the detail pane's
 * `:sourceId` segment would then have to mean two things.
 */
export function useOpenAddSourceDialog(): (
  type: EventSourceTypeContribution,
  onCreated: (sourceId: string) => void,
) => void {
  const openDialog = useOpenDialog();
  return useCallback(
    (type, onCreated) => {
      void openDialog(
        (close) => (
          <AddSourceDialog type={type} onCreated={onCreated} onClose={close} />
        ),
        // Not dismissible by an outside press: the form holds a part-filled set of
        // source fields (often a pasted URL or token) that a stray click would drop.
        { dismissible: false },
      );
    },
    [openDialog],
  );
}

function AddSourceDialog({
  type,
  onCreated,
  onClose,
}: {
  type: EventSourceTypeContribution;
  onCreated: (sourceId: string) => void;
  onClose: () => void;
}): ReactElement {
  const [name, setName] = useState("");
  const [refresh, setRefresh] = useState<RefreshCadence>("manual");
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialConfigValues(type.configFields),
  );
  // Client-side validation failures, kept apart from the server's: the two have
  // different causes and the user needs to know which one refused.
  const [issues, setIssues] = useState<string[]>([]);

  const create = useCreateEventSource();

  const submit = (): void => {
    // Validate against the type's OWN field record before posting. The server
    // runs the identical `fieldsToZodObject` check and answers 400, so this is a
    // fast path, never the only gate — and a 400 that slips through is rendered
    // below rather than swallowed.
    const parsed = fieldsToZodObject(type.configFields).safeParse(values);
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map((issue) => {
          const path = issue.path.join(".");
          return path ? `${path}: ${issue.message}` : issue.message;
        }),
      );
      return;
    }
    setIssues([]);
    create.mutate(
      {
        body: {
          type: type.id,
          name: name.trim() === "" ? undefined : name.trim(),
          config: parsed.data as Record<string, unknown>,
          refresh,
        },
      },
      {
        onSuccess: (source) => {
          onCreated(source.id);
          onClose();
        },
      },
    );
  };

  return (
    <Stack gap="lg" className="w-[32rem] max-w-full">
      <Stack gap="2xs">
        {/* Plain text, no icon row: `DialogTitle` renders an <h2>, which only
            admits phrasing content — the type's icon is already on the `+` menu
            item the user just clicked. */}
        <DialogTitle>Add {type.label} source</DialogTitle>
        <DialogDescription>
          Sources feed the events database. You can change everything here later
          from the source&apos;s own pane.
        </DialogDescription>
      </Stack>

      <Stack gap="xs">
        <Text as="label" variant="label">
          Name
        </Text>
        <Input
          value={name}
          placeholder="Defaults to the page host"
          onChange={(e) => setName(e.target.value)}
        />
      </Stack>

      <SourceConfigForm
        fields={type.configFields}
        values={values}
        onChange={(key, value) =>
          setValues((prev) => ({ ...prev, [key]: value }))
        }
      />

      <Stack gap="xs">
        <Text as="label" variant="label">
          Refresh
        </Text>
        <SegmentedControl
          options={CADENCE_SEGMENTS}
          value={refresh}
          onChange={setRefresh}
        />
      </Stack>

      {issues.length > 0 && (
        <Stack gap="2xs">
          {issues.map((issue) => (
            <Text key={issue} as="p" variant="caption" tone="destructive">
              {issue}
            </Text>
          ))}
        </Stack>
      )}

      {create.error && (
        <Text as="p" variant="caption" tone="destructive">
          {getEndpointErrorMessage(create.error)}
        </Text>
      )}

      <Line className="gap-sm">
        <Fill />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="default" disabled={create.isPending} onClick={submit}>
          {create.isPending ? "Adding…" : "Add source"}
        </Button>
      </Line>
    </Stack>
  );
}
