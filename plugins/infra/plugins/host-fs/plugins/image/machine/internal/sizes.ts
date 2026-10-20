import { join } from "node:path";
import {
  refusalFor,
  resolveOrRefuse,
  resolvedOrNull,
  listHostPath,
  watchHostDir,
} from "@plugins/infra/plugins/host-fs/machine";
import type { LiveKeyRange } from "@plugins/network/plugins/live/core";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { sliceRange } from "@plugins/network/plugins/live/server";
import {
  hostFsFolderImageSizes,
  isResizableName,
  type FolderImageSize,
} from "../../core";
import { sizeOf } from "../../server/internal/sizes";

/**
 * The resizable images of one page's range, measured: the folder is listed,
 * its resizable names cut to the range FIRST (the key reads only `name`), and
 * only those headers read — the rest of the folder is not opened.
 */
async function pageOf(
  path: string | undefined,
  range: LiveKeyRange,
): Promise<FolderImageSize[]> {
  const listed = await listHostPath(
    resolveOrRefuse(hostFsFolderImageSizes.refuse, path),
  );
  if (listed.kind !== "ok") {
    throw refusalFor(hostFsFolderImageSizes.refuse, listed);
  }
  const names = listed.entries
    .filter((e) => e.kind === "file" && isResizableName(e.name))
    .map((e) => ({ name: e.name }));
  const page = sliceRange<{ name: string }>(
    hostFsFolderImageSizes,
    names,
    range,
  );
  const sizes = await Promise.all(
    page.map(({ name }) => sizeOf(join(listed.path, name))),
  );
  return page.flatMap(({ name }, i) => {
    const size = sizes[i];
    // A file deleted between the listing and its read is no longer there.
    return size ? [{ name, size }] : [];
  });
}

/**
 * A folder's image sizes, paged by name, pushed from a watch of the folder
 * (`watchHostDir`) for as long as a question of it is read; a header already
 * read for a file's current version is not read again (`sizeOf`'s memo).
 */
export const hostFsFolderImageSizesServed = serveValue(hostFsFolderImageSizes, {
  source: "external",
  changes: "notified",
  throttleMs: 1_000,
  loader: (q, range) => pageOf(q.path, range),
  whileSubscribed: async (q, notify) => {
    const abs = resolvedOrNull(q.path);
    // The loader refuses the spelling; there is nothing to watch.
    if (abs === null) return () => {};
    return watchHostDir(abs, () => notify());
  },
});
