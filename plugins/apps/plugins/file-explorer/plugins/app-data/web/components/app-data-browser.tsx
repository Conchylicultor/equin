import { useMemo, useState, type ReactNode } from "react";
import {
  dataFileRoots,
  dataFileStat,
  dataFolderListing,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  DataView,
  defineDataView,
  useLivePagedValuePaging,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import type { ResourceReadiness } from "@plugins/primitives/plugins/live-state/core";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { FileTypeIcon } from "@plugins/primitives/plugins/file-type/web";
import { FileView } from "@plugins/primitives/plugins/file-viewer/web";
import type { FileRef } from "@plugins/primitives/plugins/file-viewer/core";
import {
  formatModified,
  formatSize,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { filesDataAtPane, filesDataPane } from "../panes";

const APP_DATA_FOLDER_VIEW = defineDataView("file-explorer.app-data.folder");

/** One entry of a root's folder, as a row. Its path (relative to the root) is its id. */
interface DataEntryRow {
  id: string;
  name: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
}

/** The folder holding `path` inside its root (`""` at the root). */
function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

/**
 * One browsable root at `at` (relative to the root; `""` is the root): a
 * folder lists itself; a file lists its folder with the file previewed beside
 * it. Read-only — the root's files on whatever host runs, pushed from the
 * root's watch.
 */
export function AppDataBrowser({
  root,
  at,
}: {
  root: string;
  at: string;
}): ReactNode {
  // The root itself is always a folder: no stat to wait for.
  const stat = useLive(dataFileStat, at === "" ? null : { root, path: at });
  if (at !== "") {
    switch (stat.status) {
      case "loading":
        return <Loading />;
      case "error":
        return (
          <Placeholder>
            <ResourceErrorInline
              variant="block"
              error={stat.error}
              refetch={stat.refetch}
              subject={at}
            />
          </Placeholder>
        );
      case "ready":
        break;
    }
  }
  const isFile = stat.status === "ready" && stat.data.entry.kind === "file";
  const dir = isFile ? parentOf(at) : at;
  const open = isFile ? at : null;
  return (
    <Split key={`${root}\u0000${dir}`} root={root} dir={dir} open={open} />
  );
}

function Split({
  root,
  dir,
  open,
}: {
  root: string;
  dir: string;
  open: string | null;
}): ReactNode {
  const file = useMemo<FileRef | null>(
    () => (open === null ? null : { source: "data", root, path: open }),
    [root, open],
  );
  return (
    <Column
      fill
      className="h-full"
      scrollBody={false}
      header={<Crumbs root={root} dir={dir} />}
      body={
        <ResizablePanelGroup
          orientation="horizontal"
          id="file-explorer-app-data-split"
        >
          <ResizablePanel id="listing" minSize="280px">
            <Folder root={root} dir={dir} open={open} />
          </ResizablePanel>
          {file !== null && (
            <>
              <ResizableHandle />
              <ResizablePanel id="preview" minSize="320px" defaultSize="55%">
                <FileView file={file} />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      }
    />
  );
}

/** App data › the root's label › each folder down to `dir`, every crumb a link. */
function Crumbs({ root, dir }: { root: string; dir: string }): ReactNode {
  const openPane = useOpenPane();
  const roots = useLive(dataFileRoots);
  // The root's id names it until its label is read (or when it cannot be).
  const label = foldResource(roots, {
    loading: () => root,
    error: () => root,
    ready: (data) => data.find((r) => r.id === root)?.label ?? root,
  });
  const crumbs: { key: string; label: string; target: LinkTarget }[] = [
    {
      key: "app-data",
      label: "App data",
      target: openPane.to(filesDataPane, {}, { mode: "root" }),
    },
    {
      key: "root",
      label,
      target: openPane.to(filesDataAtPane, { root }, { mode: "root" }),
    },
  ];
  const segments = dir === "" ? [] : dir.split("/");
  segments.forEach((name, i) => {
    const path = segments.slice(0, i + 1).join("/");
    crumbs.push({
      key: path,
      label: name,
      target: openPane.to(
        filesDataAtPane,
        { root, at: path },
        { mode: "root" },
      ),
    });
  });
  return (
    <Bar tier="pane">
      <Fill>
        <Text variant="label" className="truncate">
          {crumbs.map((c, i) => (
            <span key={c.key}>
              {i > 0 && " › "}
              <a {...activationProps(c.target)} className="hover:underline">
                {c.label}
              </a>
            </span>
          ))}
        </Text>
      </Fill>
    </Bar>
  );
}

function Folder({
  root,
  dir,
  open,
}: {
  root: string;
  dir: string;
  open: string | null;
}): ReactNode {
  const openPane = useOpenPane();
  const [now] = useState(() => Date.now());
  const query = useMemo(
    () => (dir === "" ? { root } : { root, path: dir }),
    [root, dir],
  );
  const { pages, paging } = useLivePagedValuePaging(dataFolderListing, query);
  const rows = useMemo(
    (): DataEntryRow[] =>
      pages.status === "ready"
        ? pages.rows.map((e) => ({
            id: dir === "" ? e.name : `${dir}/${e.name}`,
            name: e.name,
            kind: e.kind,
            size: e.size,
            mtimeMs: e.mtimeMs,
          }))
        : [],
    [pages, dir],
  );
  const readiness: ResourceReadiness =
    pages.status === "ready" ? { status: "ready" } : pages;
  const fields = useMemo(
    (): FieldDef<DataEntryRow>[] => [
      {
        id: "fileType",
        label: "Type",
        type: "icon",
        header: false,
        filterable: false,
        sortable: false,
        groupable: false,
        value: (r) => r.name,
        cell: (r) => (
          <FileTypeIcon
            name={r.name}
            isDir={r.kind === "dir"}
            className="size-4"
          />
        ),
      },
      { id: "name", label: "Name", primary: true, value: (r) => r.name },
      {
        id: "kind",
        label: "Kind",
        type: "enum",
        options: [
          { value: "dir", label: "Folder" },
          { value: "file", label: "File" },
        ],
        value: (r) => r.kind,
      },
      {
        id: "size",
        label: "Size",
        type: "byte-size",
        value: (r) => (r.kind === "dir" ? null : r.size),
        cell: (r) => (r.kind === "dir" ? null : formatSize(r.size)),
      },
      {
        id: "modified",
        label: "Modified",
        type: "date",
        value: (r) => new Date(r.mtimeMs),
        cell: (r) => formatModified(r.mtimeMs, now),
      },
    ],
    [now],
  );
  return (
    <DataView<DataEntryRow>
      storageKey={APP_DATA_FOLDER_VIEW}
      rows={rows}
      readiness={readiness}
      paging={paging ?? undefined}
      fields={fields}
      rowKey={(r) => r.id}
      views={["list"]}
      selectedRowId={open ?? undefined}
      emptyState={<Placeholder>This folder is empty</Placeholder>}
      rowActivation={(r) =>
        openPane.to(filesDataAtPane, { root, at: r.id }, { mode: "root" })
      }
    />
  );
}
