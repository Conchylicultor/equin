import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  computerVolume,
  type FileVolume,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { hostVolume } from "../../server/internal/volume";
import { refusalFor, resolveOrRefuse } from "./refuse";

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
