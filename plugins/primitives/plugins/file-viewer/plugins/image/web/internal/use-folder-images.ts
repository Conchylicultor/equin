import { useMemo } from "react";
import {
  compareHostFsNames,
  HOST_FS_PEEK_MAX_NAMES,
  hostFsListing,
  type HostFsEntry,
} from "@plugins/infra/plugins/host-fs/core";
import {
  hostFsFolderImageSizes,
  hostResizedAsset,
  type FolderImageSize,
  isResizableName,
} from "@plugins/infra/plugins/host-fs/plugins/image/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  codeDir,
  type CodeDirEntry,
} from "@plugins/code-explorer/plugins/code-api/core";
import {
  fileUrl,
  locationName,
  type FileLocation,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import type { ViewerImage } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import {
  assetUrlOver,
  useAssetSrcs,
} from "@plugins/infra/plugins/endpoints/web";
import {
  useTransport,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import { supportsImage } from "./supports";

/** The folder a file sits in, in the same spelling as the file's path. */
function parentDir(file: FileLocation): string {
  const slash = file.path.lastIndexOf("/");
  if (file.fs === "computer")
    return slash <= 0 ? "/" : file.path.slice(0, slash);
  return slash < 0 ? "" : file.path.slice(0, slash);
}

function siblingRef(
  file: FileLocation,
  dir: string,
  name: string,
): FileLocation {
  const path =
    file.fs === "computer"
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

function viewerImage(
  file: FileLocation,
  src: string,
  host: HostFacts | null,
  transport: Transport,
): ViewerImage {
  const image: ViewerImage = { src, name: locationName(file) };
  if (host === null || file.fs !== "computer") return image;
  const { path } = file;
  return {
    ...image,
    ...(host.size ?? {}),
    // The viewer loads a copy by URL on its own: where no URL reaches the
    // copy (an in-browser server), it keeps the original it already holds.
    resized: (edge) => {
      const copy = assetUrlOver(
        transport,
        hostResizedAsset(path, edge, host.version),
      );
      return copy.kind === "ready" ? copy.url : src;
    },
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
 * A folder on the computer's disk (host-fs's live `host-fs.list` and
 * `host-fs.image-sizes`, pushed while read) gives its raster images resized
 * copies (thumbnails, and a screen-sized stage) and, once their headers are
 * read, their pixel sizes. A file in the browser's storage is the image alone
 * until file-systems serves folder listings (session 2 of
 * research/2026-11-09-global-one-file-system-api.md), which will replace these
 * per-system listings with one.
 */
export function useFolderImages(file: FileLocation): {
  images: readonly ViewerImage[];
  /** A host folder's listing or sizes are still on their way: the images
   *  will gain their copies and sizes when they land. */
  pending: boolean;
} {
  const dir = parentDir(file);
  const hostQuery = file.fs === "computer" ? { path: dir } : null;
  const host = useLive(hostFsListing, hostQuery, HOST_READ);
  const sizes = useLive(hostFsFolderImageSizes, hostQuery, HOST_READ);
  const inWorkspace = useLive(
    codeDir,
    file.fs === "checkout"
      ? {
          worktree: file.checkout,
          dir,
          ...(file.version !== undefined ? { ref: file.version } : {}),
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
    const entries = file.fs === "computer" ? hostEntries : workspaceEntries;
    if (entries === null) return null;
    return entries
      .filter((e) => e.kind === "file" && supportsImage(e.name) !== false)
      .map((e) => e.name)
      .sort(byName);
  }, [file.fs, hostEntries, workspaceEntries]);

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
  const self = locationName(file);
  const members: readonly { ref: FileLocation; name: string }[] =
    names === null || !names.includes(self)
      ? [{ ref: file, name: self }]
      : names.map((name) => ({ ref: siblingRef(file, dir, name), name }));
  // Each image's bytes over the subtree's transport (`useAssetSrcs`); one not
  // loadable yet (or here) joins the set once it is.
  const transport = useTransport();
  const srcs = useAssetSrcs(members.map((m) => fileUrl(m.ref)));
  const images = members.flatMap((m, i) => {
    const src = srcs[i];
    return src?.kind === "ready"
      ? [viewerImage(m.ref, src.src, facts?.get(m.name) ?? null, transport)]
      : [];
  });
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
      file.fs === "computer" &&
      (host.status === "loading" || sizes.status === "loading"),
  };
}
