import { useState } from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  trashEntries,
  purgeTrash,
  type TrashEntryRow,
} from "@plugins/infra/plugins/trash/core";
// The pages trash source id — owned by the plugin that registers the source, so
// the server chokepoint and this dialog can never drift apart.
import { PAGES_TRASH_SOURCE } from "@plugins/page/plugins/editor/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { PagesSidebarRow } from "@plugins/apps/plugins/pages/plugins/shell/web";
import { PurgeTrashEntryContext, TrashItemActions } from "./trash-item-actions";

const deleteIcon = symbol("delete");

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const TRASH_VIEW = defineDataView("pages.trash");

// The pages source's slice of the trash ledger, newest-deleted first, read as
// live key-range pages kept live by the rows on screen: a trash, restore, purge
// or the 30-day sweep reaches the open list through the change feed, and the
// scroll pages the whole trash with no depth cap. Search matches the label
// captured at trash time.
const trashSource = liveDataSource(trashEntries, {
  searchable: ["label"],
}).scoped({ where: { sourceId: PAGES_TRASH_SOURCE } });

// How the derived fields present here. `label` is the entry's name (the page
// title when it was trashed; its value stays the column's, an empty one only
// drawn as "Untitled") and the list's only searched column, never offered as a
// filter; `deletedAt` the one sortable column, trailing as a relative time. The
// scope column is not the list's to show.
const overrides = fieldOverrides(trashEntries, {
  sourceId: { visible: false, filterable: false },
  label: {
    label: "Page",
    cell: (e) => e.label || "Untitled",
    primary: true,
    filterable: false,
  },
  deletedAt: {
    cell: (e) => <RelativeTime date={e.deletedAt} />,
    align: "end",
  },
});

/**
 * Sidebar "Trash" trigger: a Row that opens a dialog listing the pages that have
 * been soft-deleted, as a DataView over the live `trashEntries` collection
 * scoped to the pages source. Each entry can be restored or permanently
 * deleted (row actions); the permanent delete is gated behind a confirm dialog
 * (the FK cascade fires at purge, so it is irreversible). Restore and purge
 * just mutate — the row leaves the list through the change feed.
 */
export function PagesTrash() {
  const [open, setOpen] = useState(false);
  // Entry pending a purge confirmation (null = no confirmation open).
  const [confirmEntry, setConfirmEntry] = useState<TrashEntryRow | null>(null);
  const purge = useEndpointMutation(purgeTrash);

  const onConfirmPurge = () => {
    if (!confirmEntry) return;
    purge.mutate(
      { params: { sourceId: PAGES_TRASH_SOURCE, entryId: confirmEntry.id } },
      { onSuccess: () => setConfirmEntry(null) },
    );
  };

  return (
    <>
      <PagesSidebarRow
        icon={deleteIcon}
        label="Trash"
        tone="default"
        onClick={() => setOpen(true)}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md">
          <DialogTitle>Trash</DialogTitle>
          <DialogDescription>
            Deleted pages are kept for 30 days before being permanently removed.
          </DialogDescription>
          {/* The content mounts only while the dialog is open, so the trash
              is read (and subscribed) only then. The DataView never owns a
              scroll; this box is its one scroller. */}
          <Scroll axis="y" className="max-h-96">
            <PurgeTrashEntryContext.Provider value={setConfirmEntry}>
              <DataView<TrashEntryRow>
                storageKey={TRASH_VIEW}
                source={trashSource}
                overrides={overrides}
                views={["list"]}
                density="compact"
                itemActions={TrashItemActions}
                emptyState="Trash is empty"
              />
            </PurgeTrashEntryContext.Provider>
          </Scroll>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmEntry !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmEntry(null);
        }}
      >
        <DialogContent size="sm">
          <DialogTitle>Delete permanently</DialogTitle>
          <DialogDescription>
            Permanently delete{" "}
            <span className="font-medium">
              {confirmEntry?.label || "Untitled"}
            </span>
            ? This removes the page and all of its content and cannot be undone.
          </DialogDescription>
          <Stack
            direction="row"
            justify="end"
            gap="sm"
            // eslint-disable-next-line spacing/no-adhoc-spacing -- action row offset below the dialog description; one-off dialog footer spacing
            className="mt-4"
          >
            <Button variant="ghost" onClick={() => setConfirmEntry(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={purge.isPending}
              onClick={() => onConfirmPurge()}
            >
              Delete permanently
            </Button>
          </Stack>
        </DialogContent>
      </Dialog>
    </>
  );
}
