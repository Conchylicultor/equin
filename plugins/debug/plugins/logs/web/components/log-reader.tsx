import { useMemo, type ReactElement } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  DataView,
  defineDataView,
  useLivePagedValuePaging,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  Inset,
  insetClass,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import {
  logLines,
  logsCatalog,
  type LogEntry,
  type LogLine,
  type LogLinesQuery,
  type LogLinesRefusal,
} from "../../shared/resources";
import {
  formatBytes,
  formatDay,
  formatLineTime,
  SCOPE_LABEL,
} from "../internal/present";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const LOG_LINES = defineDataView("debug.logs.lines");

const NO_LINES: LogLine[] = [];

/**
 * One log, newest line first, across its whole kept history: scrolling down
 * pages back through the live file and on into each rotation (a line says which
 * file holds it), and a new line arrives at the top while the log is written.
 * With `at`, it reads back from that instant instead — the line at it selected
 * — which is what a link from a report to its evidence opens.
 */
export function LogReader({
  worktree,
  log,
  at,
  onShowNewest,
}: {
  worktree: string;
  log: string;
  at: number | null;
  onShowNewest: () => void;
}): ReactElement {
  const catalog = useLive(logsCatalog, { worktree });
  // The header describes the log once the catalog says what it is; until then
  // (or if that read fails) it names the log and nothing more.
  const entry = foldResource(catalog, {
    loading: () => null,
    error: () => null,
    ready: (d) => d.entries.find((e) => e.id === log) ?? null,
  });

  const { pages, paging } = useLivePagedValuePaging<
    LogLine,
    undefined,
    LogLinesQuery,
    LogLinesQuery,
    LogLinesRefusal
  >(logLines, {
    worktree,
    log,
    at,
  });
  const readiness = useMemo(
    () =>
      pages.status === "ready"
        ? { status: "ready" as const, data: pages.rows }
        : pages,
    [pages],
  );
  const rows = pages.status === "ready" ? pages.rows : NO_LINES;

  const fields = useMemo<FieldDef<LogLine>[]>(
    () => [
      {
        id: "t",
        label: "Time",
        type: "date",
        value: (l) => (l.t === null ? null : new Date(l.t)),
        cell: (l) =>
          l.t === null ? null : (
            <Text
              variant="code"
              tone="faint"
              className="tabular-nums"
              title={new Date(l.t).toString()}
            >
              {formatLineTime(l.t)}
            </Text>
          ),
        width: "8rem",
      },
      {
        id: "stream",
        label: "Stream",
        type: "enum",
        value: (l) => l.stream ?? "none",
        options: [
          { value: "stdout", label: "stdout" },
          { value: "stderr", label: "stderr" },
          { value: "none", label: "—" },
        ],
        cell: (l) =>
          l.stream === "stderr" ? (
            <Badge variant="destructive">stderr</Badge>
          ) : null,
        filterable: true,
        width: "5rem",
      },
      {
        id: "text",
        label: "Line",
        type: "text",
        primary: true,
        value: (l) => l.text,
        cell: (l) => (
          <Text
            variant="code"
            tone={l.stream === "stderr" ? "destructive" : "default"}
            className="truncate"
            title={l.text}
          >
            {l.text}
          </Text>
        ),
        width: "minmax(0,1fr)",
      },
      {
        id: "generation",
        label: "File",
        type: "number",
        value: (l) => l.generation,
        cell: (l) => (
          <Text variant="caption" tone="faint">
            {l.generation === 0 ? "live" : `.${l.generation}`}
          </Text>
        ),
        filterable: true,
        width: "4rem",
      },
    ],
    [],
  );

  return (
    <Column
      fill
      scrollBody={false}
      header={
        <>
          <ReaderHeader log={log} entry={entry} />
          {at !== null && (
            <Inset pad="sm" className="border-b bg-muted">
              <Stack direction="row" gap="sm" align="center" wrap>
                <Text variant="caption">
                  Reading back from <b>{formatDay(at)}</b> — the selected line
                  is the newest written at or before it.
                </Text>
                <Button variant="link" onClick={onShowNewest}>
                  Show newest
                </Button>
              </Stack>
            </Inset>
          )}
        </>
      }
      body={
        <DataView<LogLine>
          rows={rows}
          fields={fields}
          rowKey={(l) => l.position}
          storageKey={LOG_LINES}
          views={["table", "list"]}
          defaultView="table"
          readiness={readiness}
          paging={paging ?? undefined}
          selectedRowId={at !== null ? rows[0]?.position : undefined}
          emptyState={
            at !== null
              ? "No line of this log was written at or before that time."
              : entry !== null && entry.files.length === 0
                ? "Declared, never written: lines appear here the moment it writes one."
                : "No lines."
          }
        />
      }
    />
  );
}

/** What the log is, where it lives, and the files its history spans. */
function ReaderHeader({
  log,
  entry,
}: {
  log: string;
  entry: LogEntry | null;
}): ReactElement {
  return (
    <Inset pad="md" className="border-b">
      <Stack gap="sm">
        <Stack direction="row" gap="sm" align="center" wrap>
          <Text variant="heading" className="font-mono">
            {log}
          </Text>
          {entry !== null && (
            <Badge variant="muted">{SCOPE_LABEL[entry.scope]}</Badge>
          )}
        </Stack>
        {entry !== null && (
          <>
            <Text variant="body" tone="muted">
              {entry.description ??
                "No sink declares this file: a browser clientLog channel, or a writer that bypassed defineLogSink."}
            </Text>
            <Stack direction="row" gap="xs" align="center">
              <Text
                variant="code"
                tone="faint"
                className="truncate"
                title={entry.path}
              >
                {entry.path}
              </Text>
              <CopyButton
                text={`tail -f ${entry.path}`}
                tooltip="Copy tail -f"
              />
            </Stack>
            <GenerationStrip entry={entry} />
          </>
        )}
      </Stack>
    </Inset>
  );
}

/**
 * The files the history spans, oldest on the left: each with the time it
 * covers and its size, the empty slots of the bound dashed — so where the
 * history ends, and why, is visible before scrolling to it.
 */
function GenerationStrip({ entry }: { entry: LogEntry }): ReactElement | null {
  const keep = entry.bound?.keep ?? entry.files.length - 1;
  if (keep < 0) return null;
  const slots = Array.from({ length: keep + 1 }, (_, i) => keep - i);
  return (
    <Stack direction="row" gap="2xs">
      {slots.map((generation) => {
        const file = entry.files.find((f) => f.generation === generation);
        const name = generation === 0 ? "live" : `.${generation}`;
        return (
          <Fill
            key={generation}
            className={cn(
              insetClass({ pad: "xs" }),
              "rounded-md border",
              file === undefined && "border-dashed",
            )}
          >
            <Stack gap="none">
              <Text variant="caption" tone="strong" className="font-mono">
                {name}
              </Text>
              <Text variant="caption" tone="muted" className="truncate">
                {file === undefined
                  ? "not yet"
                  : `${formatDay(file.bornMs)} → ${generation === 0 ? "now" : formatDay(file.modifiedMs)} · ${formatBytes(file.bytes)}`}
              </Text>
            </Stack>
          </Fill>
        );
      })}
    </Stack>
  );
}
