import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  ScrollArea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DataView,
  defineDataView,
  liveDataSource,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { toast } from "@plugins/shell/plugins/notifications/web";
import {
  historyVersions,
  restoreVersion,
  type Version,
} from "@plugins/history/plugins/engine/core";
import { useNewestVersion } from "../internal/use-newest-version";
import {
  RestoreVersionContext,
  VersionItemActions,
} from "./version-item-actions";
export interface VersionHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** History source id (e.g. "pages"). */
  sourceId: string;
  /** The source's own id for the versioned entity (e.g. a page block id). */
  entityId: string;
  /**
   * Renders the snapshot preview for the active version. The host owns the
   * snapshot shape and rendering (e.g. a faithful diffed block view), keeping
   * this dialog fully domain-agnostic.
   */
  renderPreview: (version: Version) => ReactNode;
}

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const VERSIONS_VIEW = defineDataView("history.versions");

// The timeline as a live source, scoped per dialog to one (source, entity): a
// snapshot recorded, a restore's "Before restore" point and the retention sweep
// all reach the open timeline through the change feed, and the scroll pages
// the whole history. Nothing to search: a version is a label and a time.
const versionsSource = liveDataSource(historyVersions, { searchable: [] });

// The fields are the timeline's sort / Properties dimensions; `createdAt` is
// the one collection column (it sorts). The row body is drawn by
// `TimelineRowBody`, so a version with no author and no checkpoint reads as a
// label and a time rather than a run of empty separators.
const fields: FieldDef<Version>[] = [
  {
    id: "label",
    label: "Version",
    type: "text",
    value: (v) => v.label || "Version",
    primary: true,
    sortable: false,
    filterable: false,
  },
  {
    id: "createdAt",
    label: "When",
    type: "date",
    value: (v) => v.createdAt,
    cell: (v) => <RelativeTime date={v.createdAt} />,
    sortable: true,
    filterable: false,
  },
  {
    id: "author",
    label: "Author",
    type: "text",
    value: (v) => v.author,
    sortable: false,
    filterable: false,
  },
];

// One timeline row: the label, then when — and whether it is a checkpoint and
// who made it, only when it says so.
function TimelineRowBody({ version }: { version: Version }) {
  return (
    <Stack gap="2xs" className={yieldClass("x")}>
      <Text as="span" variant="body" className="truncate">
        {version.label || "Version"}
      </Text>
      <Text as="span" variant="caption" tone="muted" className="truncate">
        <RelativeTime date={version.createdAt} />
        {version.pinned ? " · checkpoint" : ""}
        {version.author ? ` · ${version.author}` : ""}
      </Text>
    </Stack>
  );
}

const timelineViewOptions = {
  list: { renderRow: (v: Version) => <TimelineRowBody version={v} /> },
};

export function VersionHistoryDialog({
  open,
  onOpenChange,
  sourceId,
  entityId,
  renderPreview,
}: VersionHistoryDialogProps) {
  // Version pending a restore confirmation (null = no confirmation open).
  const [pendingRestore, setPendingRestore] = useState<Version | null>(null);

  // No invalidation: the timeline is live, so the restore's "Before restore"
  // point and its new version land in it through the change feed.
  const restore = useEndpointMutation(restoreVersion, {
    onSuccess: () => {
      toast({
        type: "history",
        title: "Version restored",
        description:
          pendingRestore?.label || "The selected version is now live.",
        variant: "success",
      });
      setPendingRestore(null);
    },
  });

  const confirmRestore = () => {
    if (!pendingRestore) return;
    void restore.mutateAsync({
      params: { sourceId, entityId, versionId: pendingRestore.id },
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="lg" className="h-[32rem]">
          {/* The content mounts only while the dialog is open, so the
              timeline is read (and subscribed) only then. */}
          <VersionHistoryBody
            sourceId={sourceId}
            entityId={entityId}
            renderPreview={renderPreview}
            onRestore={setPendingRestore}
          />
        </DialogContent>
      </Dialog>

      {/* Restore confirmation — destructive-but-reversible. */}
      <Dialog
        open={pendingRestore !== null}
        onOpenChange={(o) => {
          if (!o) setPendingRestore(null);
        }}
      >
        <DialogContent size="sm">
          <DialogTitle>Restore this version?</DialogTitle>
          <DialogDescription>
            Your current page is saved as a version before restoring, so you can
            undo this.
          </DialogDescription>
          <Stack
            direction="row"
            gap="sm"
            justify="end"
            // eslint-disable-next-line spacing/no-adhoc-spacing -- action row offset below the dialog description; one-off dialog footer spacing
            className="mt-4"
          >
            <Button
              variant="ghost"
              onClick={() => setPendingRestore(null)}
              disabled={restore.isPending}
            >
              Cancel
            </Button>
            <Button onClick={confirmRestore} loading={restore.isPending}>
              Restore
            </Button>
          </Stack>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The dialog's two panes: the timeline DataView (its own loading, empty and
 * paging states) and the preview of the active version — the user's pick, or
 * the newest until they make one.
 */
function VersionHistoryBody({
  sourceId,
  entityId,
  renderPreview,
  onRestore,
}: {
  sourceId: string;
  entityId: string;
  renderPreview: (version: Version) => ReactNode;
  onRestore: (version: Version) => void;
}) {
  // The user's explicit pick (null = none yet: the newest is previewed).
  const [picked, setPicked] = useState<Version | null>(null);
  const newest = useNewestVersion(sourceId, entityId);
  const source = useMemo(
    () => versionsSource.scoped({ where: { sourceId, entityId } }),
    [sourceId, entityId],
  );
  const active =
    picked ?? (newest.status === "ready" ? (newest.data[0] ?? null) : null);

  return (
    <HistoryPanes
      timeline={
        <RestoreVersionContext.Provider value={onRestore}>
          <DataView<Version>
            storageKey={VERSIONS_VIEW}
            source={source}
            fields={fields}
            views={["list"]}
            density="compact"
            itemActions={VersionItemActions}
            selectedRowId={active?.id}
            onRowActivate={setPicked}
            viewOptions={timelineViewOptions}
            emptyState="No versions yet."
          />
        </RestoreVersionContext.Provider>
      }
      preview={
        <VersionPreview
          active={active}
          newest={newest}
          renderPreview={renderPreview}
        />
      }
    />
  );
}

function VersionPreview({
  active,
  newest,
  renderPreview,
}: {
  active: Version | null;
  newest: ReturnType<typeof useNewestVersion>;
  renderPreview: (version: Version) => ReactNode;
}) {
  if (active) return renderPreview(active);
  switch (newest.status) {
    case "loading":
      return (
        <Inset pad="lg">
          <Loading variant="block" />
        </Inset>
      );
    case "error":
      return (
        <Inset pad="lg">
          <ResourceErrorInline
            variant="block"
            subject="the newest version"
            error={newest.error}
            refetch={newest.refetch}
          />
        </Inset>
      );
    case "ready":
      // `active` falls back to the newest, so a ready read with no active
      // version is an empty history.
      return (
        <Inset pad="lg">
          <Placeholder>No versions yet.</Placeholder>
        </Inset>
      );
  }
}

/** The dialog's chrome: header, the timeline column and the preview pane. */
function HistoryPanes({
  timeline,
  preview,
}: {
  timeline: ReactNode;
  preview: ReactNode;
}) {
  return (
    <Column
      className="h-full"
      header={
        // The panel owns the inset (its `lg` rail is exactly the `px-lg`
        // this band used to apply), so the band applies none of its own
        // and BLEEDS instead: its rule spans the whole panel while the
        // title lands back on the panel's rail. Safe here — the band is a
        // direct child of the panel, whose `overflow-x-hidden` clips a
        // bleed, unlike a child of an inner ScrollArea.
        <div className="border-b rail-bleed py-sm">
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Browse past versions and restore any of them.
          </DialogDescription>
        </div>
      }
      scrollBody={false}
      body={
        <Stack direction="row" gap="none" align="stretch" className="h-full">
          {/* LEFT — timeline column, newest first. */}
          <Column
            // Rigid timeline pane in the two-pane stretch split.
            // eslint-disable-next-line layout/no-adhoc-layout -- rigid left pane of the two-pane stretch split
            className="w-72 shrink-0 border-r"
            header={
              <Inset x="md" t="sm" b="2xs">
                <SectionLabel>Timeline</SectionLabel>
              </Inset>
            }
            scrollBody={false}
            body={
              <ScrollArea className="h-full">
                <Inset x="xs" b="xs">
                  {timeline}
                </Inset>
              </ScrollArea>
            }
          />

          {/* RIGHT — host-injected preview of the active version.
              The shadcn ScrollArea keeps its styled scrollbar; it's the
              flexible pane filling the remaining width and height of the
              two-pane stretch split. */}
          {/* eslint-disable-next-line layout/no-adhoc-layout -- flexible right pane (styled ScrollArea) of the two-pane stretch split */}
          <ScrollArea className="min-h-0 flex-1">{preview}</ScrollArea>
        </Stack>
      }
    />
  );
}
