import { useMemo } from "react";
import { useEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { hostFsList } from "@plugins/infra/plugins/host-fs/core";
import {
  hostFsImageSizes,
  hostResizedUrl,
  isResizableName,
} from "@plugins/infra/plugins/host-fs/plugins/image/core";
import { listCodeDir } from "@plugins/code-explorer/plugins/code-api/core";
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

/**
 * Every image in `file`'s folder, by name — what the viewer steps through
 * with ← / →. Until the folder is listed (or when it cannot be: missing,
 * denied), the set is the file alone (`pending` says which); a failed request
 * throws.
 *
 * A host folder's raster images also carry resized copies (thumbnails, and a
 * screen-sized stage) and, once their headers are read, their pixel sizes.
 */
export function useFolderImages(file: FileRef): {
  images: readonly ViewerImage[];
  /** A host folder's listing or sizes are still on their way: the images
   *  will gain their copies and sizes when they land. */
  pending: boolean;
} {
  const dir = parentDir(file);
  const host = useEndpoint(
    hostFsList,
    {},
    { query: { path: dir }, enabled: file.source === "host" },
  );
  const sizes = useEndpoint(
    hostFsImageSizes,
    {},
    { query: { path: dir }, enabled: file.source === "host" },
  );
  const inWorkspace = useEndpoint(
    listCodeDir,
    { worktree: file.source === "workspace" ? file.workspace : "" },
    {
      query:
        file.source === "workspace" && file.ref !== undefined
          ? { dir, ref: file.ref }
          : { dir },
      enabled: file.source === "workspace",
    },
  );
  const query = file.source === "host" ? host : inWorkspace;

  const names = useMemo((): readonly string[] | null => {
    const result = query.data;
    if (result?.kind !== "ok") return null;
    return result.entries
      .filter((e) => e.kind === "file" && supportsImage(e.name) !== false)
      .map((e) => e.name);
  }, [query.data]);

  const facts = useMemo((): ReadonlyMap<string, HostFacts> | null => {
    const listed = host.data;
    if (file.source !== "host" || listed?.kind !== "ok") return null;
    const known = new Map<string, { width: number; height: number }>();
    if (sizes.data?.kind === "ok") {
      for (const { name, size } of sizes.data.images)
        if (size.kind === "known") known.set(name, size);
    }
    const out = new Map<string, HostFacts>();
    for (const e of listed.entries) {
      if (e.kind !== "file" || !isResizableName(e.name)) continue;
      out.set(e.name, {
        version: { mtimeMs: e.mtimeMs, size: e.size },
        size: known.get(e.name) ?? null,
      });
    }
    return out;
  }, [file.source, host.data, sizes.data]);

  // Memoized by the React Compiler (a manual useMemo here cannot be kept).
  const self = fileRefName(file);
  const images =
    names === null || !names.includes(self)
      ? [viewerImage(file, facts?.get(self) ?? null)]
      : names.map((name) =>
          viewerImage(siblingRef(file, dir, name), facts?.get(name) ?? null),
        );
  if (query.isError) throw query.error;
  if (sizes.isError) throw sizes.error;
  return {
    images,
    pending: file.source === "host" && (host.isPending || sizes.isPending),
  };
}
