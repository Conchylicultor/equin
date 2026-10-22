import { useMemo, type ReactElement } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  ResourceErrorInline,
  foldResource,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { backgroundEntryKey, type BackgroundEntry } from "../../core";
import { useCatalogHalves } from "../internal/use-entries";
import {
  ENTRY_STATUSES,
  ENTRY_STATUS_LABEL,
  entryStatus,
  runResultText,
  triggerWords,
} from "../internal/present";
import { EntryStatusDot } from "./entry-status-dot";
import { NextRun } from "./next-run";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const BACKGROUND_VIEW = defineDataView("infra.background.catalog");

const NO_ENTRIES: BackgroundEntry[] = [];

/**
 * Debug → Background activity: everything this backend — and the machine-wide
 * central runtime — runs on its own, one row per declared entry, pushed live.
 * The rows come from declarations, so nothing registered can run without
 * appearing here.
 *
 * The list's readiness is this backend's half. The central half loads on its
 * own: until it answers (or if it fails) a line above the list says so, rather
 * than the list silently lacking its rows.
 */
export function BackgroundView({
  selectedKey,
  linkTo,
}: {
  selectedKey: string | undefined;
  /** Where a row goes: a link, so middle- / ⌘-click open it in a browser tab. */
  linkTo: (entry: BackgroundEntry) => LinkTarget;
}): ReactElement {
  const { worktree: result, central } = useCatalogHalves();
  const worktreeRows = foldResource(result, {
    loading: () => NO_ENTRIES,
    error: () => NO_ENTRIES,
    ready: (d) => d,
  });
  const centralRows = foldResource(central, {
    loading: () => NO_ENTRIES,
    error: () => NO_ENTRIES,
    // No central runtime behind this subtree (the demo): it runs nothing here.
    unavailable: () => NO_ENTRIES,
    ready: (d) => d,
  });
  const rows = useMemo(
    () =>
      centralRows.length === 0
        ? worktreeRows
        : [...worktreeRows, ...centralRows],
    [worktreeRows, centralRows],
  );

  // The groups are the providers' own vocabulary, and the catalog is loaded
  // whole (it is bounded by the declared set), so its values ARE the options.
  const groupOptions = useMemo(
    () =>
      [...new Set(rows.map((r) => r.group))].map((g) => ({
        value: g,
        label: g,
      })),
    [rows],
  );

  const fields = useMemo<FieldDef<BackgroundEntry>[]>(
    () => [
      {
        id: "description",
        label: "What it does",
        type: "text",
        primary: true,
        value: (r) => r.description,
        sortable: true,
      },
      {
        id: "group",
        label: "Kind",
        type: "enum",
        value: (r) => r.group,
        options: groupOptions,
        filterable: true,
        groupable: true,
        visible: false,
      },
      {
        id: "status",
        label: "Status",
        type: "enum",
        value: entryStatus,
        options: ENTRY_STATUSES.map((value) => ({
          value,
          label: ENTRY_STATUS_LABEL[value],
        })),
        filterable: true,
        groupable: true,
        visible: false,
      },
      {
        id: "visibility",
        label: "Visibility",
        type: "enum",
        value: (r) => (r.internal ? "internal" : "shown"),
        options: [
          { value: "shown", label: "Shown" },
          { value: "internal", label: "Internal plumbing" },
        ],
        filterable: true,
        visible: false,
      },
      {
        id: "name",
        label: "Code name",
        type: "text",
        value: (r) => r.name,
        sortable: true,
        visible: false,
      },
      {
        id: "lastRun",
        label: "Last run",
        type: "date",
        value: (r) =>
          r.lastRun === null ? null : new Date(r.lastRun.startedAt),
        sortable: true,
        visible: false,
      },
    ],
    [groupOptions],
  );

  return (
    <>
      {central.status === "loading" ? (
        <Loading
          variant="text"
          label="Loading what the central runtime runs…"
        />
      ) : central.status === "error" ? (
        <ResourceErrorInline
          variant="inline"
          subject="what the central runtime runs"
          error={central.error}
          refetch={central.refetch}
        />
      ) : central.status === "unavailable" ? (
        <Text variant="caption" tone="muted">
          {central.message}
        </Text>
      ) : null}
      <DataView<BackgroundEntry>
        rows={rows}
        fields={fields}
        rowKey={backgroundEntryKey}
        views={["list"]}
        storageKey={BACKGROUND_VIEW}
        readiness={result}
        selectedRowId={selectedKey}
        rowActivation={linkTo}
        searchAccessor={(r) => `${r.description} ${r.name} ${r.group}`}
        searchPlaceholder="Search what runs…"
        viewOptions={{
          list: {
            leading: (r: BackgroundEntry) => (
              <EntryStatusDot status={entryStatus(r)} />
            ),
            renderRow: (r: BackgroundEntry) => <EntryRowBody entry={r} />,
          },
        }}
        emptyState={<>Nothing matches.</>}
      />
    </>
  );
}

/**
 * One entry: what it does over its code name, then when it runs over when it
 * next will, then how it last went. Each line is its own line container, so a
 * long sentence ellipsizes instead of pushing the columns out.
 */
function EntryRowBody({ entry }: { entry: BackgroundEntry }): ReactElement {
  return (
    <>
      <Fill>
        <Stack gap="none">
          <Line>
            <Text variant="label">{entry.description}</Text>
          </Line>
          <Line>
            <Text variant="code" tone="muted">
              {entry.name}
            </Text>
          </Line>
        </Stack>
      </Fill>
      <Stack gap="none" align="end" className={rigidClass()}>
        <Line>
          <Text variant="caption">{triggerWords(entry.trigger)}</Text>
        </Line>
        <Line>
          <Text variant="caption" tone="muted">
            <WhenNext entry={entry} />
          </Text>
        </Line>
      </Stack>
      <Stack gap="none" align="end" className={`w-24 ${rigidClass()}`}>
        <LastRunLine entry={entry} />
      </Stack>
    </>
  );
}

function WhenNext({ entry }: { entry: BackgroundEntry }): ReactElement | null {
  if (!entry.runsHere) return <>on main</>;
  if (entry.trigger.kind !== "cron" || entry.trigger.nextAt === null) {
    return null;
  }
  return <NextRun at={new Date(entry.trigger.nextAt)} />;
}

function LastRunLine({ entry }: { entry: BackgroundEntry }): ReactElement {
  const run = entry.lastRun;
  if (run === null) {
    return (
      <Line>
        <Text variant="caption" tone="faint">
          {entry.runsHere ? "not run yet" : "—"}
        </Text>
      </Line>
    );
  }
  return (
    <>
      <Line>
        <Text variant="caption" tone="muted">
          <RelativeTime date={new Date(run.startedAt)} />
        </Text>
      </Line>
      <Line>
        <Text
          variant="caption"
          tone={run.outcome === "failed" ? "destructive" : "muted"}
        >
          {runResultText(run)}
        </Text>
      </Line>
    </>
  );
}
