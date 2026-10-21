import { useMemo } from "react";
import {
  compareHostFsNames,
  HOST_FS_PEEK_MAX_NAMES,
  hostFsListing,
  type HostFsEntry,
} from "@plugins/infra/plugins/host-fs/core";
import {
  hostFsFolderImageSizes,
  hostResizedUrl,
  type FolderImageSize,
  isResizableName,
} from "@plugins/infra/plugins/host-fs/plugins/image/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  codeDir,
  type CodeDirEntry,
} from "@plugins/code-explorer/plugins/code-api/core";
import {
  fileRefName,
  fileUrl,
  type FileRef,
} from "@plugins/primitives/plugins/file-viewer/core";
import type { ViewerImage } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { supportsImage } from "./supports";

/** The folder a file sits in, in the same spelling as the file's path. */
function parentDir(file: FileRef): string {
  const slash = file.path.lastIndexOf("/");
  if (file.source === "host")
    return slash <= 0 ? "/" : file.path.slice(0, slash);
  return slash < 0 ? "" : file.path.slice(0, slash);
}

function siblingRef(file: FileRef, dir: string, name: string): FileRef {
  const path =
    file.source === "host"
      ? `${dir === "/" ? "" : dir}/${name}`
      : dir === ""
        ? name
        : `${dir}/${name}`;
  return { ...file, path };
}

/** What a host listing and the sizes read add to one image: the version its
 *  resized copies are named by, and its upright size. */
interface HostFacts {
  version: { mtimeMs: number; size: number };
  size: { width: number; height: number } | null;
}

function viewerImage(file: FileRef, host: HostFacts | null): ViewerImage {
  const image: ViewerImage = { src: fileUrl(file), name: fileRefName(file) };
  if (host === null || file.source !== "host") return image;
  const { path } = file;
  return {
    ...image,
    ...(host.size ?? {}),
    resized: (edge) => hostResizedUrl(path, edge, host.version),
  };
}

/** By name as host-fs shows a folder. */
const byName = compareHostFsNames;

// A host folder's listing and sizes are read whole, in one page: the viewer
// steps through every image of the folder. Bounded by the values' `maxLimit`
// (the same cap past which host-fs's `peek` stops naming children).
const HOST_READ = { limit: HOST_FS_PEEK_MAX_NAMES };
// A workspace folder's listing likewise, bounded by `code.dir`'s `maxLimit`
// (the same 10 000 entries).
const WORKSPACE_READ = { limit: 10_000 };

/**
 * Every image in `file`'s folder, by name — what the viewer steps through
 * with ← / →. Until the folder is listed (or when it cannot be: missing,
 * denied, no computer behind the app), the set is the file alone (`pending`
 * says which); a failed read throws. A workspace folder is code-api's live
 * `code.dir` (on disk now, or as of the file's ref), pushed while read.
 *
 * A host folder (host-fs's live `host-fs.list` and `host-fs.image-sizes`,
 * pushed while read) gives its raster images resized copies (thumbnails, and
 * a screen-sized stage) and, once their headers are read, their pixel sizes.
 */
export function useFolderImages(file: FileRef): {
  images: readonly ViewerImage[];
  /** A host folder's listing or sizes are still on their way: the images
   *  will gain their copies and sizes when they land. */
  pending: boolean;
} {
  const dir = parentDir(file);
  const hostQuery = file.source === "host" ? { path: dir } : null;
  const host = useLive(hostFsListing, hostQuery, HOST_READ);
  const sizes = useLive(hostFsFolderImageSizes, hostQuery, HOST_READ);
  const inWorkspace = useLive(
    codeDir,
    file.source === "workspace"
      ? {
          worktree: file.workspace,
          dir,
          ...(file.ref !== undefined ? { ref: file.ref } : {}),
        }
      : null,
    WORKSPACE_READ,
  );

  // A host folder's entries, once listed; `null` while they are not known
  // (`pending` says so), when the folder cannot be listed, or with no computer
  // behind the app — the set is then the file alone.
  let hostEntries: readonly HostFsEntry[] | null;
  switch (host.status) {
    case "ready":
      hostEntries = host.data;
      break;
    case "loading":
    case "error":
    case "unavailable":
      hostEntries = null;
      break;
  }
  // A workspace folder's entries, likewise.
  let workspaceEntries: readonly CodeDirEntry[] | null;
  switch (inWorkspace.status) {
    case "ready":
      workspaceEntries = inWorkspace.data;
      break;
    case "loading":
    case "error":
    case "unavailable":
      workspaceEntries = null;
      break;
  }
  const names = useMemo((): readonly string[] | null => {
    const entries = file.source === "host" ? hostEntries : workspaceEntries;
    if (entries === null) return null;
    return entries
      .filter((e) => e.kind === "file" && supportsImage(e.name) !== false)
      .map((e) => e.name)
      .sort(byName);
  }, [file.source, hostEntries, workspaceEntries]);

  // The sizes measured so far; none while they are on their way (`pending`),
  // refused or unreadable here — the images then carry no size.
  let sizesData: readonly FolderImageSize[] | null;
  switch (sizes.status) {
    case "ready":
      sizesData = sizes.data;
      break;
    case "loading":
    case "error":
    case "unavailable":
      sizesData = null;
      break;
  }
  const facts = useMemo((): ReadonlyMap<string, HostFacts> | null => {
    if (hostEntries === null) return null;
    const known = new Map<string, { width: number; height: number }>();
    for (const { name, size } of sizesData ?? [])
      if (size.kind === "known") known.set(name, size);
    const out = new Map<string, HostFacts>();
    for (const e of hostEntries) {
      if (e.kind !== "file" || !isResizableName(e.name)) continue;
      out.set(e.name, {
        version: { mtimeMs: e.mtimeMs, size: e.size },
        size: known.get(e.name) ?? null,
      });
    }
    return out;
  }, [hostEntries, sizesData]);

  // Memoized by the React Compiler (a manual useMemo here cannot be kept).
  const self = fileRefName(file);
  const images =
    names === null || !names.includes(self)
      ? [viewerImage(file, facts?.get(self) ?? null)]
      : names.map((name) =>
          viewerImage(siblingRef(file, dir, name), facts?.get(name) ?? null),
        );
  // A refusal (missing, denied, …) is the folder's answer — the file alone;
  // any other failure is a bug to surface.
  if (host.status === "error" && host.error.kind !== "refused")
    throw host.error;
  if (sizes.status === "error" && sizes.error.kind !== "refused")
    throw sizes.error;
  if (inWorkspace.status === "error" && inWorkspace.error.kind !== "refused")
    throw inWorkspace.error;
  return {
    images,
    pending:
      file.source === "host" &&
      (host.status === "loading" || sizes.status === "loading"),
  };
}
