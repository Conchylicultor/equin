import { mkdir } from "node:fs/promises";
import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import {
  depsCacheDir,
  depsPinsState,
} from "@plugins/infra/plugins/deps/data-dirs";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { pinDrift } from "../../core";
import { currentPinDrift, pinnedDepIds } from "./check";
import { onMainMoved } from "./reaction";

/** Open only while someone is subscribed to `deps.pin-drift` (the health dot). */
export const pinnedDepsWatcher = defineFileWatcher({
  name: "deps.pinned",
  description:
    "While the health report reads the pinned binaries' row, watches the pinned dependencies' cache dirs and their review records, so a moved pin (`./equin deps pin`), a daemon's fresh start (its running hold) or a stay (`./equin deps pin-stay`) shows at once.",
  // The payloads: only the holds and state files beside them matter.
  ignore: ["**/env/**"],
});

/**
 * The pinned dependencies against main, pushed. Its inputs change two ways,
 * both observed: main's checkout moves (its bun.lock — the ref reaction) and
 * the pins' holds move (`./equin deps pin`, a daemon's fresh start — a
 * watcher on just the pinned dependencies' cache dirs, a handful of small
 * files). External: nothing is DB-backed.
 */
export const pinDriftServed = serveValue(pinDrift, {
  source: "external",
  changes: "notified",
  loader: () => currentPinDrift(),
  whileSubscribed: async (_params, notify) => {
    const [root, reviews] = await Promise.all([
      depsCacheDir.ensure(),
      depsPinsState.ensure(),
    ]);
    const dirs = await Promise.all(
      (await pinnedDepIds()).map(async (id) => {
        const dir = joinAppPath(root, id);
        // Watched before the first install creates it.
        await mkdir(dir, { recursive: true });
        return dir;
      }),
    );
    // A lag's review record (its clock, a stay set or lifted).
    dirs.push(reviews);
    const watcher = await pinnedDepsWatcher.start({
      dirs,
      onChange: () => notify(),
    });
    const offMain = onMainMoved(() => notify());
    return () => {
      offMain();
      void runTracked("deps-pinned:watcher-stop", () => watcher.stop());
    };
  },
});
