import { serveValue } from "@plugins/network/plugins/live/machine";
import { hostFsPathStat, type HostFsPathStat } from "../../core";
import {
  computerVolume,
  type FileVolume,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { statHostOrArchivePath } from "../../server/internal/stat";
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
      ...(stat.read !== undefined ? { read: stat.read } : {}),
    };
  },
  whileSubscribed: ({ path }, notify) => watchPath(path, () => notify()),
});

/** The storage of a volume, measured whenever a reader asks. */
export const computerVolumeServed = serveValue(computerVolume, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "free space moves with every write anywhere on the volume, which nothing signals; measured on mount and on Refresh",
    },
  },
  loader: async ({ path }): Promise<FileVolume> => {
    const volume = await hostVolume(
      resolveOrRefuse(computerVolume.refuse, path),
    );
    if (volume.kind !== "ok") throw refusalFor(computerVolume.refuse, volume);
    return {
      path: volume.path,
      name: volume.name,
      total: volume.total,
      free: volume.free,
    };
  },
});
