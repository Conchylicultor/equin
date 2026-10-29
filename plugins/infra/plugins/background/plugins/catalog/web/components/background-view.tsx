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
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { backgroundEntryKey, type BackgroundEntry } from "../../core";
import { useCatalogHalves } from "../internal/use-entries";
import {
  ENTRY_STATUS_OPTIONS,
  entryStatusOptions,
  entryStatus,
  runResultText,
  triggerWords,
} from "../internal/present";
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
        options: entryStatusOptions(
          Object.keys(
            ENTRY_STATUS_OPTIONS,
          ) as (keyof typeof ENTRY_STATUS_OPTIONS)[],
        ),
        filterable: true,
        groupable: true,
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
        type: "identifier",
        value: (r) => r.name,
        sortable: true,
      },
      {
        id: "trigger",
        label: "Runs",
        type: "text",
        value: (r) => triggerWords(r.trigger),
      },
      {
        id: "nextRun",
        label: "Next",
        type: "text",
        value: (r) => (r.runsHere ? "" : "on main"),
        cell: (r) => (
          <Text variant="caption" tone="muted">
            <WhenNext entry={r} />
          </Text>
        ),
      },
      {
        id: "result",
        label: "Result",
        type: "text",
        value: (r) => (r.lastRun === null ? "" : runResultText(r.lastRun)),
        cell: (r) => <LastRunResult entry={r} />,
      },
      {
        id: "lastRun",
        label: "Last run",
        type: "date",
        value: (r) =>
          r.lastRun === null ? null : new Date(r.lastRun.startedAt),
        sortable: true,
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
        emptyState={<>Nothing matches.</>}
      />
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

function LastRunResult({ entry }: { entry: BackgroundEntry }): ReactElement {
  const run = entry.lastRun;
  if (run === null) {
    return (
      <Text variant="caption" tone="faint">
        {entry.runsHere ? "not run yet" : "—"}
      </Text>
    );
  }
  return (
    <Text
      variant="caption"
      tone={run.outcome === "failed" ? "destructive" : "muted"}
    >
      {runResultText(run)}
    </Text>
  );
}
