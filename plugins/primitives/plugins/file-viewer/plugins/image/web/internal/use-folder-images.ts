import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  codeDir,
  type CodeDirEntry,
} from "@plugins/code-explorer/plugins/code-api/core";
import {
  FILE_PEEK_MAX_NAMES,
  FILE_SYSTEMS,
  compareFileNames,
  computerImageSizes,
  computerResizedAsset,
  fileUrl,
  isResizableName,
  locationName,
  type BrowsableFileSystem,
  type FileEntry,
  type FileLocation,
  type FolderImageSize,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { useFolderListing } from "@plugins/infra/plugins/paths/plugins/file-systems/web";
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

/**
 * The folder a file sits in, in the same spelling as the file's path: a
 * browsable system's paths are absolute or `~`-rooted, a checkout's relative
 * to its root (`""` at the root).
 */
function parentDir(file: FileLocation): string {
  const slash = file.path.lastIndexOf("/");
  if (file.fs !== "checkout")
    return slash <= 0 ? "/" : file.path.slice(0, slash);
  return slash < 0 ? "" : file.path.slice(0, slash);
}

function siblingRef(
  file: FileLocation,
  dir: string,
  name: string,
): FileLocation {
  const path =
    file.fs !== "checkout"
      ? `${dir === "/" ? "" : dir}/${name}`
      : dir === ""
        ? name
        : `${dir}/${name}`;
  return { ...file, path };
}

/** What a folder listing and the sizes read add to one image of a system
 *  with image copies: the version its resized copies are named by, and its
 *  upright size. */
interface ImageFacts {
  version: { mtimeMs: number; size: number };
  size: { width: number; height: number } | null;
}

function viewerImage(
  file: FileLocation,
  src: string,
  facts: ImageFacts | null,
  transport: Transport,
): ViewerImage {
  const image: ViewerImage = { src, name: locationName(file) };
  // Only the computer's disk makes image copies (`capabilities.images`):
  // `facts` is null for every other system.
  if (facts === null || file.fs !== "computer") return image;
  const { path } = file;
  return {
    ...image,
    ...(facts.size ?? {}),
    // The viewer loads a copy by URL on its own: where no URL reaches the
    // copy (an in-browser server), it keeps the original it already holds.
    resized: (edge) => {
      const copy = assetUrlOver(
        transport,
        computerResizedAsset(path, edge, facts.version),
      );
      return copy.kind === "ready" ? copy.url : src;
    },
  };
}

/** By name as a folder is shown. */
const byName = compareFileNames;

// A folder's sizes are read whole, in one page, as its listing is
// (`useFolderListing`): the viewer steps through every image of the folder.
// Bounded by the value's `maxLimit`.
const SIZES_READ = { limit: FILE_PEEK_MAX_NAMES };
// A workspace folder's listing likewise, bounded by `code.dir`'s `maxLimit`
// (the same 10 000 entries).
const WORKSPACE_READ = { limit: 10_000 };

/**
 * Every image in `file`'s folder, by name — what the viewer steps through
 * with ← / →. Until the folder is listed (or when it cannot be: missing,
 * denied, a system this host cannot run), the set is the file alone
 * (`pending` says which); a failed read throws. A browsable system's folder
 * is its live listing (`useFolderListing`); a checkout folder is code-api's
 * live `code.dir` (on disk now, or as of the file's ref) — both pushed while
 * read.
 *
 * A folder of a system with image copies (`capabilities.images`: the
 * computer's disk) gives its raster images resized copies (thumbnails, and a
 * screen-sized stage) and, once their headers are read, their pixel sizes.
 */
export function useFolderImages(file: FileLocation): {
  images: readonly ViewerImage[];
  /** A folder's listing or sizes are still on their way: the images will
   *  gain their siblings, copies and sizes when they land. */
  pending: boolean;
} {
  const dir = parentDir(file);
  const browsable: BrowsableFileSystem | null =
    file.fs === "checkout" ? null : file.fs;
  // The listing hook reads a system every render; a checkout reads none.
  const listing = useFolderListing(
    browsable ?? "computer",
    browsable === null ? null : dir,
  ).pages;
  const measured =
    browsable !== null && FILE_SYSTEMS[browsable].capabilities.images;
  const sizes = useLive(
    computerImageSizes,
    measured && browsable === "computer" ? { path: dir } : null,
    SIZES_READ,
  );
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

  // A browsable folder's entries, once listed; `null` while they are not
  // known (`pending` says so), when the folder cannot be listed, or for a
  // system this host cannot run — the set is then the file alone.
  let listedEntries: readonly FileEntry[] | null;
  switch (listing.status) {
    case "ready":
      listedEntries = listing.data;
      break;
    case "loading":
    case "error":
    case "unavailable":
      listedEntries = null;
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
    const entries = browsable !== null ? listedEntries : workspaceEntries;
    if (entries === null) return null;
    return entries
      .filter((e) => e.kind === "file" && supportsImage(e.name) !== false)
      .map((e) => e.name)
      .sort(byName);
  }, [browsable, listedEntries, workspaceEntries]);

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
  const facts = useMemo((): ReadonlyMap<string, ImageFacts> | null => {
    if (!measured || listedEntries === null) return null;
    const known = new Map<string, { width: number; height: number }>();
    for (const { name, size } of sizesData ?? [])
      if (size.kind === "known") known.set(name, size);
    const out = new Map<string, ImageFacts>();
    for (const e of listedEntries) {
      if (e.kind !== "file" || !isResizableName(e.name)) continue;
      out.set(e.name, {
        version: { mtimeMs: e.mtimeMs, size: e.size },
        size: known.get(e.name) ?? null,
      });
    }
    return out;
  }, [measured, listedEntries, sizesData]);

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
  if (listing.status === "error" && listing.error.kind !== "refused")
    throw listing.error;
  if (sizes.status === "error" && sizes.error.kind !== "refused")
    throw sizes.error;
  if (inWorkspace.status === "error" && inWorkspace.error.kind !== "refused")
    throw inWorkspace.error;
  return {
    images,
    pending:
      browsable !== null &&
      (listing.status === "loading" ||
        (measured && sizes.status === "loading")),
  };
}
