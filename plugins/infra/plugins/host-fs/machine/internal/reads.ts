import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  HOST_FS_TEXT_MAX_BYTES,
  hostFsFileText,
  hostFsPathStat,
  hostFsVolumeInfo,
  type HostFsFileText,
  type HostFsPathStat,
  type HostFsVolumeInfo,
} from "../../core";
import { statHostOrArchivePath } from "../../server/internal/stat";
import { readHostPathText } from "../../server/internal/text";
import { hostVolume } from "../../server/internal/volume";
import { refusalFor, resolveOrRefuse, resolvedOrNull } from "./refuse";
import { watchHostPath } from "./version";

/** Watch one host path while a tuple of it is read — its entry, or its archive's. */
async function watchPath(
  path: string,
  notify: () => void,
): Promise<() => void> {
  const abs = resolvedOrNull(path);
  // The loader refuses the spelling; there is nothing to watch.
  if (abs === null) return () => {};
  return watchHostPath(abs, notify);
}

/** One host path described, pushed from a watch of the folder holding it. */
export const hostFsPathStatServed = serveValue(hostFsPathStat, {
  source: "external",
  changes: "notified",
  loader: async ({ path }): Promise<HostFsPathStat> => {
    const stat = await statHostOrArchivePath(
      resolveOrRefuse(hostFsPathStat.refuse, path),
    );
    if (stat.kind !== "ok") throw refusalFor(hostFsPathStat.refuse, stat);
    return {
      path: stat.path,
      parent: stat.parent,
      entry: stat.entry,
      ...(stat.within !== undefined ? { within: stat.within } : {}),
    };
  },
  whileSubscribed: ({ path }, notify) => watchPath(path, () => notify()),
});

/**
 * A host file's text, on demand: re-read over HTTP by each tab after the
 * watch of its folder invalidates it.
 */
export const hostFsFileTextServed = serveValue(hostFsFileText, {
  source: "external",
  changes: "notified",
  loader: async ({ path }): Promise<HostFsFileText> => {
    const text = await readHostPathText(
      resolveOrRefuse(hostFsFileText.refuse, path),
    );
    switch (text.kind) {
      case "ok":
        return { path: text.path, content: text.content, size: text.size };
      case "too-large":
        throw hostFsFileText.refuse(
          "too-large",
          `${text.path} is ${text.size} bytes, over the ${HOST_FS_TEXT_MAX_BYTES}-byte text limit`,
        );
      case "binary":
        throw hostFsFileText.refuse("binary", `${text.path} is a binary file`);
      case "missing":
      case "denied":
      case "not-a-file":
      case "unreadable-archive":
        throw refusalFor(hostFsFileText.refuse, text);
    }
  },
  whileSubscribed: ({ path }, notify) => watchPath(path, () => notify()),
});

/** The storage of a volume, measured whenever a reader asks. */
export const hostFsVolumeInfoServed = serveValue(hostFsVolumeInfo, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "free space moves with every write anywhere on the volume, which nothing signals; measured on mount and on Refresh",
    },
  },
  loader: async ({ path }): Promise<HostFsVolumeInfo> => {
    const volume = await hostVolume(
      resolveOrRefuse(hostFsVolumeInfo.refuse, path),
    );
    if (volume.kind !== "ok") throw refusalFor(hostFsVolumeInfo.refuse, volume);
    return {
      path: volume.path,
      name: volume.name,
      total: volume.total,
      free: volume.free,
    };
  },
});
