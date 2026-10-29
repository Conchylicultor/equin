import { useMemo, type ReactElement } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
  type FieldOption,
} from "@plugins/primitives/plugins/data-view/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  RelativeTime,
  useNow,
} from "@plugins/primitives/plugins/relative-time/web";
import { LOG_SCOPES, logsCatalog, type LogEntry } from "../../shared/resources";
import { bytesOnDisk, lastWrite, SCOPE_LABEL } from "../internal/present";
import { SizeMeter } from "./size-meter";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const LOGS_CATALOG = defineDataView("debug.logs.catalog");

const NO_ENTRIES: LogEntry[] = [];

/** A log never written says so after its name; a written one says nothing. */
const WRITTEN_OPTIONS: FieldOption[] = [
  { value: "false", label: "never written", variant: "muted" },
  { value: "true", label: "Written", quiet: true },
];

const CATALOG_PLACE = { written: "afterTitle" } as const;

/**
 * Every log of one worktree — what each records, its size against its rotation
 * bound, its kept files, its last write — live: the folders holding them are
 * watched, so a write, a rotation or a new file reaches the list.
 */
export function LogsCatalog({
  worktree,
  selectedId,
  linkTo,
}: {
  worktree: string;
  selectedId: string | undefined;
  /** Where a row goes: a link, so ⌘/middle-click opens the log in a browser tab. */
  linkTo: (id: string) => LinkTarget;
}): ReactElement {
  const result = useLive(logsCatalog, { worktree });
  // The DataView renders the loading and failed states (`readiness`); only a
  // ready catalog's rows reach the view.
  const entries = foldResource(result, {
    loading: () => NO_ENTRIES,
    error: () => NO_ENTRIES,
    ready: (d) => d.entries,
  });
  // The "rotates in" estimate is relative to now; a minute is precise enough.
  const now = useNow(60_000);

  const fields = useMemo<FieldDef<LogEntry>[]>(
    () => [
      {
        id: "id",
        label: "Log",
        type: "identifier",
        primary: true,
        value: (e) => e.id,
        width: "minmax(0,1fr)",
      },
      {
        id: "written",
        label: "Written",
        type: "enum",
        valueDomain: "boolean",
        value: (e) => e.files.length > 0,
        options: WRITTEN_OPTIONS,
        filterable: true,
      },
      {
        id: "description",
        label: "Description",
        type: "multiline-text",
        value: (e) => e.description ?? null,
        cell: (e) => (
          <span title={e.description ?? e.path}>
            {e.description ?? "No sink declares this file."}
          </span>
        ),
      },
      {
        id: "scope",
        label: "Where",
        type: "enum",
        value: (e) => e.scope,
        options: LOG_SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] })),
        filterable: true,
        width: "9rem",
      },
      {
        id: "size",
        label: "Size",
        type: "byte-size",
        value: (e) => bytesOnDisk(e),
        cell: (e) => <SizeMeter entry={e} now={now} />,
        sortable: true,
        width: "11rem",
      },
      {
        id: "lastWrite",
        label: "Last write",
        type: "date",
        value: (e) => {
          const t = lastWrite(e);
          return t === null ? null : new Date(t);
        },
        cell: (e) => {
          const t = lastWrite(e);
          return t === null ? (
            <Text variant="caption" tone="faint">
              never
            </Text>
          ) : (
            <Text variant="caption" tone="muted">
              <RelativeTime date={new Date(t)} />
            </Text>
          );
        },
        sortable: true,
        width: "6rem",
      },
    ],
    [now],
  );

  return (
    <DataView<LogEntry>
      rows={entries}
      fields={fields}
      rowKey={(e) => e.id}
      storageKey={LOGS_CATALOG}
      views={["table", "list"]}
      defaultView="table"
      // "Never written" is a mark after the log's name, not the row's state.
      place={CATALOG_PLACE}
      readiness={result}
      selectedRowId={selectedId}
      rowActivation={(e) => linkTo(e.id)}
      emptyState="No logs here."
    />
  );
}
