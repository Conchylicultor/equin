import { useMemo, type ReactElement } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
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
        type: "text",
        primary: true,
        value: (e) => e.id,
        cell: (e) => (
          <Stack gap="none">
            <Stack direction="row" gap="xs" align="center">
              <Text variant="code" tone="strong" className="truncate">
                {e.id}
              </Text>
              {e.files.length === 0 && (
                <Badge variant="muted">never written</Badge>
              )}
            </Stack>
            <Text
              variant="caption"
              tone="muted"
              className="truncate"
              title={e.description ?? e.path}
            >
              {e.description ?? "No sink declares this file."}
            </Text>
          </Stack>
        ),
        width: "minmax(0,1fr)",
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
        type: "number",
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
        align: "end",
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
      readiness={result}
      selectedRowId={selectedId}
      rowActivation={(e) => linkTo(e.id)}
      emptyState="No logs here."
    />
  );
}
