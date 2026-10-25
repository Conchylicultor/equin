import {
  Button,
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useMemo, useState, type ReactElement } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import {
  getEndpointErrorMessage,
  useFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import { interpolatePath } from "@plugins/infra/plugins/endpoints/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { readNdjson } from "@plugins/infra/plugins/ndjson-stream/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  useLivePagedValuePaging,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  bulkDeleteWorktrees,
  deleteWorktree,
  type ReapStep,
} from "../../shared/endpoints";
import {
  worktreeScan,
  type WorktreeEntry,
  type WorktreeScanMeta,
  type WorktreeScanQuery,
} from "../../shared/scan";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const deleteIcon = symbol("delete");
const folderDeleteIcon = symbol("folder-delete");
const refreshIcon = symbol("refresh");
const warningIcon = symbol("warning");

const WORKTREES = defineDataView("debug.worktree-cleanup.worktrees");
const NO_ROWS: readonly WorktreeEntry[] = [];

/**
 * A field shown but never sorted, filtered, grouped or searched by: the rows
 * are key-range pages by `createdAt`, and the DataView would do any of those
 * in memory over the loaded pages only — "Safe = true" would show the safe
 * rows of the pages loaded while "Delete N safe" removes the whole scan's.
 */
const ONLY_SHOWN = {
  sortable: false,
  filterable: false,
  groupable: false,
} as const;

// The reap's steps, then its outcome — and, apart from it, a failure to
// re-read the row after it (the list then shows the row as it was).
type DeleteEvent =
  | { step: ReapStep }
  | { refreshError: string }
  | { ok: true }
  | { ok: false; error: string };

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

const STATUS_COLOR: Record<string, string> = {
  done: "bg-success/10 text-success",
  dropped: "bg-muted text-muted-foreground",
  in_progress: "bg-info/10 text-info",
  need_action: "bg-warning/10 text-warning",
  attempted: "bg-muted text-muted-foreground",
  // A worktree dir on disk with no attempt row behind it — nothing but the
  // checkout itself is left to describe it.
  orphan: "bg-warning/10 text-warning",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge colorClass={STATUS_COLOR[status]} className="inline-block">
      {status}
    </Badge>
  );
}

/** What is left of a worktree on disk and in the cluster, in one word. */
type Remains = "fully-clean" | "no-dir" | "clean" | "uncommitted";

function remainsOf(entry: WorktreeEntry): Remains {
  if (!entry.dirExists && !entry.dbExists) return "fully-clean";
  if (!entry.dirExists) return "no-dir";
  return entry.isDirty ? "uncommitted" : "clean";
}

function DirtyIndicator({ entry }: { entry: WorktreeEntry }) {
  switch (remainsOf(entry)) {
    case "fully-clean":
      return (
        <Text as="span" variant="caption" className="text-success">
          fully clean
        </Text>
      );
    case "no-dir":
      return (
        <Text
          as="span"
          variant="caption"
          className="text-muted-foreground italic"
        >
          no dir
        </Text>
      );
    case "clean":
      return (
        <Text as="span" variant="caption" className="text-muted-foreground">
          clean
        </Text>
      );
    case "uncommitted":
      return (
        <Text as="div" variant="caption" className="text-warning">
          <Stack direction="row" gap="xs" align="center">
            <Icon icon={warningIcon} className="size-3.5" />
            uncommitted
          </Stack>
        </Text>
      );
  }
}

/** The scan's progress, or once it is complete what it found. */
function ScanSummary({ meta }: { meta: WorktreeScanMeta }): ReactElement {
  return (
    <Text
      as="span"
      variant="caption"
      className="text-muted-foreground truncate"
    >
      {meta.complete
        ? `${meta.scanned} worktree${meta.scanned !== 1 ? "s" : ""} · ${meta.safe} safe to delete`
        : `Scanning… ${meta.scanned}${meta.planned === null ? "" : ` / ${meta.planned}`}`}
    </Text>
  );
}

/**
 * Debug → Worktree Cleanup: every worktree this host knows, newest first, with
 * its hygiene and a Delete per row. One scan per mount and per Refresh
 * (`debug.worktree-cleanup.worktrees`, each a new question at the clock's
 * now), filled in live as rows are built and paged by the rows on screen; a
 * delete re-reads the rows it touched, so the list stays true after it.
 */
export function WorktreeCleanupPanel() {
  const fetchEndpoint = useFetchEndpoint();
  // The instant the scan is asked for — a new one is a new scan.
  const [at, setAt] = useState(() => Date.now());
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const query = useMemo((): WorktreeScanQuery => ({ at }), [at]);
  const meta = useLive(worktreeScan.meta, query);
  const { pages, paging } = useLivePagedValuePaging<
    WorktreeEntry,
    WorktreeScanMeta,
    WorktreeScanQuery,
    WorktreeScanQuery
  >(worktreeScan, query);
  const readiness = useMemo(
    () =>
      pages.status === "ready"
        ? { status: "ready" as const, data: pages.rows }
        : pages,
    [pages],
  );
  const rows = pages.status === "ready" ? pages.rows : NO_ROWS;

  const fields = useMemo<FieldDef<WorktreeEntry>[]>(
    () => [
      {
        id: "task",
        label: "Task",
        type: "text",
        primary: true,
        width: "minmax(0,1fr)",
        ...ONLY_SHOWN,
        value: (e) => e.taskTitle,
        cell: (e) => (
          <Stack gap="2xs">
            <Text
              as="span"
              variant="caption"
              className="truncate font-medium"
              title={e.taskTitle}
            >
              {e.taskTitle}
            </Text>
            <Stack direction="row" gap="xs" align="center">
              <StatusBadge status={e.taskStatus} />
              <span className="text-3xs text-muted-foreground font-mono truncate">
                {e.worktreePath.split("/").pop() ?? e.attemptId}
              </span>
            </Stack>
          </Stack>
        ),
      },
      {
        id: "taskStatus",
        label: "Status",
        type: "enum",
        visible: false,
        ...ONLY_SHOWN,
        value: (e) => e.taskStatus,
        options: [...Object.keys(STATUS_COLOR), "unknown"].map((s) => ({
          value: s,
          label: s,
        })),
      },
      {
        id: "createdAt",
        label: "Age",
        type: "date",
        width: "5rem",
        ...ONLY_SHOWN,
        value: (e) => new Date(e.createdAt),
        cell: (e) => (
          <Text
            as="span"
            variant="caption"
            className="text-muted-foreground whitespace-nowrap"
          >
            {relativeAge(e.createdAt)}
          </Text>
        ),
      },
      {
        id: "remains",
        label: "Dirty?",
        type: "enum",
        width: "8rem",
        ...ONLY_SHOWN,
        value: remainsOf,
        options: [
          { value: "uncommitted", label: "uncommitted", variant: "warning" },
          { value: "clean", label: "clean" },
          { value: "no-dir", label: "no dir" },
          { value: "fully-clean", label: "fully clean", variant: "success" },
        ],
        cell: (e) => <DirtyIndicator entry={e} />,
      },
      {
        id: "isSafe",
        label: "Safe",
        type: "bool",
        width: "4rem",
        ...ONLY_SHOWN,
        value: (e) => e.isSafe,
      },
      {
        id: "delete",
        label: "Delete",
        header: false,
        width: "10rem",
        align: "end",
        filterable: false,
        sortable: false,
        cell: (e) => <DeleteAction entry={e} />,
      },
    ],
    [],
  );

  const safeCount =
    meta.status === "ready" && meta.data.complete ? meta.data.safe : 0;

  return (
    <Stack gap="none" className="h-full">
      {/* Header */}
      <Stack
        direction="row"
        gap="md"
        align="center"
        justify="between"
        className="px-lg py-md border-b"
      >
        <Stack
          direction="row"
          gap="sm"
          align="center"
          className={fillClasses("x")}
        >
          <Text
            as="h2"
            variant="label"
            className={cn("font-semibold", rigidClass())}
          >
            Worktree Cleanup
          </Text>
          {meta.status === "loading" && (
            <Text as="span" variant="caption" className="text-muted-foreground">
              Scanning…
            </Text>
          )}
          {meta.status === "ready" && <ScanSummary meta={meta.data} />}
          {meta.status === "error" && (
            <ResourceErrorInline
              error={meta.error}
              // A failed scan is held as failed: Retry asks a new question.
              refetch={async () => {
                setBulkResult(null);
                setAt(Date.now());
              }}
              variant="inline"
              subject="the worktree scan"
            />
          )}
        </Stack>
        <Stack direction="row" gap="sm" align="center" className={rigidClass()}>
          <Button
            variant="destructive"
            disabled={safeCount === 0}
            onClick={async () => {
              setBulkResult(null);
              try {
                const { succeeded, failed } = await fetchEndpoint(
                  bulkDeleteWorktrees,
                  {},
                  { body: { at } },
                );
                setBulkResult(
                  failed.length === 0
                    ? `Deleted ${succeeded} worktree${succeeded !== 1 ? "s" : ""}`
                    : `Deleted ${succeeded}, ${failed.length} error${failed.length !== 1 ? "s" : ""}: ${failed
                        .map((f) => `${f.id}: ${f.error}`)
                        .join("; ")}`,
                );
              } catch (e) {
                setBulkResult(`Error: ${getEndpointErrorMessage(e)}`);
              }
            }}
          >
            {/* eslint-disable-next-line spacing/no-adhoc-spacing -- icon-to-label inset inside a Button; parent is a 3rd-party Button, no gap to own it */}
            <Icon icon={folderDeleteIcon} className="size-4 mr-1.5" />
            Delete {safeCount} safe
          </Button>
          <IconButton
            icon={refreshIcon}
            label="Refresh"
            variant="outline"
            loading={
              meta.status === "loading" ||
              (meta.status === "ready" && !meta.data.complete)
            }
            onClick={() => {
              setBulkResult(null);
              setAt(Date.now());
            }}
          />
        </Stack>
      </Stack>

      {/* Automatic-reaper policy note */}
      <Text
        as="div"
        variant="caption"
        className="px-lg py-sm text-muted-foreground border-b"
      >
        Orphaned forks, config dirs, and gateway registry entries are reclaimed
        hourly; worktrees are deleted automatically after 90 days. Use the
        controls below to reap early.
      </Text>

      {/* Bulk result banner */}
      {bulkResult && (
        <Text
          as="div"
          variant="caption"
          className="px-lg py-sm bg-muted text-muted-foreground border-b"
        >
          {bulkResult}
        </Text>
      )}

      {/* Content */}
      <Scroll axis="both" fill>
        <DataView<WorktreeEntry>
          rows={rows}
          fields={fields}
          rowKey={(e) => e.attemptId}
          storageKey={WORKTREES}
          views={["table", "list"]}
          defaultView="table"
          readiness={readiness}
          paging={paging ?? undefined}
          emptyState="No worktrees found."
        />
      </Scroll>
    </Stack>
  );
}

// One label per step of the reap, keyed on the shared `ReapStep` list — so a step
// added on the server is a `tsc` error here until it is given something to say,
// rather than streaming a name the panel silently has no label for.
const STEP_LABEL: Record<ReapStep, string> = {
  worktree: "Removing…",
  // The apps this checkout built and served, each with its own database.
  namespaces: "Removing the apps it served…",
  database: "Dropping DB…",
  config: "Clearing config…",
  registry: "Deregistering…",
};

/**
 * One row's Delete: streams the reap's steps into its label, and — for a
 * worktree the reaper would not call safe — asks first. The row itself is
 * re-read by the server once the reap ends, so the list never needs a reload.
 */
function DeleteAction({ entry }: { entry: WorktreeEntry }): ReactElement {
  const transport = useTransport();
  const [step, setStep] = useState<ReapStep | null>(null);
  const branchName = entry.worktreePath.split("/").pop() ?? entry.attemptId;

  const reap = async (): Promise<void> => {
    setStep("worktree");
    try {
      for await (const frame of readNdjson(
        transport,
        deleteWorktree.route,
        interpolatePath(deleteWorktree.path, { id: entry.attemptId }),
        { method: "DELETE" },
      )) {
        const event = frame as DeleteEvent;
        if ("step" in event) setStep(event.step);
        else if ("refreshError" in event)
          showToast({
            variant: "error",
            title: `Could not re-read ${branchName} after the delete`,
            description: event.refreshError,
          });
        else if (!event.ok)
          showToast({
            variant: "error",
            title: `Could not delete ${branchName}`,
            description: event.error,
          });
      }
    } catch (e) {
      showToast({
        variant: "error",
        title: `Could not delete ${branchName}`,
        description: getEndpointErrorMessage(e),
      });
    } finally {
      setStep(null);
    }
  };

  if (!entry.dirExists && !entry.dbExists) {
    return (
      <ControlSizeProvider size="sm">
        <Button variant="ghost" disabled className="opacity-40 cursor-default">
          {/* eslint-disable-next-line spacing/no-adhoc-spacing -- icon-to-label inset inside a Button; parent is a 3rd-party Button, no gap to own it */}
          <Icon icon={deleteIcon} className="size-3.5 mr-1" />
          Drop DB
        </Button>
      </ControlSizeProvider>
    );
  }
  return (
    <ControlSizeProvider size="sm">
      <Button
        variant={entry.isSafe || !entry.dirExists ? "outline" : "ghost"}
        disabled={step !== null}
        onClick={() => {
          if (!entry.isSafe && entry.dirExists) {
            void confirmDialog({
              title: "Delete anyway?",
              description: entry.isDirty
                ? "This worktree has uncommitted changes."
                : "This worktree is not finished (open conversation, open task, or under 72 h old).",
              confirmLabel: "Delete",
              onConfirm: () => {
                void reap();
              },
            });
            return;
          }
          void reap();
        }}
      >
        {step !== null ? (
          <>
            {/* eslint-disable-next-line spacing/no-adhoc-spacing -- icon-to-label inset inside a Button; parent is a 3rd-party Button, no gap to own it */}
            <Spinner className="size-3.5 mr-1" />
            {STEP_LABEL[step]}
          </>
        ) : (
          <>
            {/* eslint-disable-next-line spacing/no-adhoc-spacing -- icon-to-label inset inside a Button; parent is a 3rd-party Button, no gap to own it */}
            <Icon icon={deleteIcon} className="size-3.5 mr-1" />
            {entry.dirExists ? "Delete" : "Drop DB"}
          </>
        )}
      </Button>
    </ControlSizeProvider>
  );
}
