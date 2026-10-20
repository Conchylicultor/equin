import { useMemo, type ReactElement } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { AutomationEntry } from "../../core";
import { useAutomations } from "../internal/use-automations";
import { NextRunWords, useAutomationJob } from "./schedule";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const AUTOMATIONS_VIEW = defineDataView("tasks.automations");

const NO_ROWS: AutomationEntry[] = [];

type AutomationState = "on" | "off";
type OpenState = "open" | "none";

const stateOf = (r: AutomationEntry): AutomationState =>
  r.enabled ? "on" : "off";

/** The tasks it has under way: a file-kind automation's open filing, or the
 * tasks a launch-kind one started that still hold a slot. */
const busyTaskIds = (r: AutomationEntry): readonly string[] =>
  r.kind === "launch"
    ? r.runningTaskIds
    : r.openTaskId === null
      ? []
      : [r.openTaskId];
const openOf = (r: AutomationEntry): OpenState =>
  busyTaskIds(r).length === 0 ? "none" : "open";

/**
 * Every automation — what files a task and launches its agent, or launches
 * agents on existing tasks, with nobody clicking anything — one row each: what
 * it is, when it runs, whether it is on, and what it has under way. The set is declared in code, so
 * the catalog is loaded whole.
 */
export function AutomationsView({
  selectedId,
  linkTo,
}: {
  selectedId: string | undefined;
  /** Where a row goes: a link, so middle- / ⌘-click open it in a browser tab. */
  linkTo: (automationId: string) => LinkTarget;
}): ReactElement {
  const result = useAutomations();
  const rows = foldResource(result, {
    loading: () => NO_ROWS,
    error: () => NO_ROWS,
    // Never reaches the view: DataView renders the message instead.
    unavailable: () => NO_ROWS,
    ready: (d) => d,
  });

  const fields = useMemo<FieldDef<AutomationEntry>[]>(
    () => [
      {
        id: "label",
        label: "Automation",
        type: "text",
        primary: true,
        value: (r) => r.label,
        sortable: true,
      },
      {
        id: "state",
        label: "State",
        type: "enum",
        value: stateOf,
        options: [
          { value: "on", label: "On", variant: "success" },
          { value: "off", label: "Off", variant: "muted" },
        ],
        filterable: true,
        groupable: true,
        visible: false,
      },
      {
        id: "open",
        label: "Open task",
        type: "enum",
        value: openOf,
        options: [
          { value: "open", label: "Has tasks under way" },
          { value: "none", label: "Nothing under way" },
        ],
        filterable: true,
        visible: false,
      },
      {
        id: "description",
        label: "What it does",
        type: "text",
        value: (r) => r.description,
        visible: false,
      },
    ],
    [],
  );

  return (
    <DataView<AutomationEntry>
      rows={rows}
      fields={fields}
      rowKey={(r) => r.id}
      views={["list"]}
      storageKey={AUTOMATIONS_VIEW}
      readiness={result}
      selectedRowId={selectedId}
      rowActivation={(r) => linkTo(r.id)}
      searchAccessor={(r) => `${r.label} ${r.description}`}
      searchPlaceholder="Search automations…"
      viewOptions={{
        list: {
          leading: (r: AutomationEntry) => <Icon icon={r.icon} />,
          renderRow: (r: AutomationEntry) => <AutomationRowBody entry={r} />,
        },
      }}
      emptyState={<>No automation is installed.</>}
    />
  );
}

/**
 * One automation: its name over when it runs, then its open task and its
 * state. Each line is its own line container, so a long schedule ellipsizes
 * instead of pushing the chips out.
 */
function AutomationRowBody({
  entry,
}: {
  entry: AutomationEntry;
}): ReactElement {
  const job = useAutomationJob(entry.trigger);
  return (
    <>
      <Fill>
        <Stack gap="none">
          <Line>
            <Text variant="label" tone={entry.enabled ? "default" : "muted"}>
              {entry.label}
            </Text>
          </Line>
          <Line>
            <Text variant="caption" tone="muted">
              {entry.trigger.words}
              {entry.enabled && entry.trigger.current === "schedule" ? (
                <NextRunWords job={job} prefix=" · " />
              ) : null}
            </Text>
          </Line>
        </Stack>
      </Fill>
      <Stack direction="row" gap="xs" align="center" className={rigidClass()}>
        <BusyBadge entry={entry} />
        {entry.enabled ? (
          <Badge variant="success">On</Badge>
        ) : (
          <Badge variant="muted">Off</Badge>
        )}
      </Stack>
    </>
  );
}

/** What it has under way: a file-kind automation's open task, or how many of
 * a launch-kind one's agents are running. */
function BusyBadge({ entry }: { entry: AutomationEntry }): ReactElement | null {
  if (entry.kind === "launch") {
    return entry.runningTaskIds.length === 0 ? null : (
      <Badge variant="info">{`${entry.runningTaskIds.length} running`}</Badge>
    );
  }
  return entry.openTaskId === null ? null : (
    <Badge variant="info">Task open</Badge>
  );
}
