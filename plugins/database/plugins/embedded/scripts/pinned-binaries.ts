import { join } from "node:path";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import {
  holdRunningDep,
  pinnedDep,
  type Ready,
} from "@plugins/infra/plugins/deps/deps";
import {
  packageCopyDir,
  packageCopyVersion,
  type PackageCopySource,
} from "@plugins/infra/plugins/deps/plugins/package-copy/deps";
import { postgresBinaries } from "@plugins/database/plugins/embedded/plugins/binaries/deps";

/** The pinned server binaries, and how to record that the cluster now runs them. */
export interface PinnedBinDir {
  binDir: string;
  /** Hold the install as the one the started postmaster runs (only after a fresh start). */
  markRunning(): Promise<void>;
}

/**
 * The cluster's binaries on a machine with a checkout: the install the pin
 * holds (`postgres-binaries`), never the checkout's `node_modules` — so a
 * `bun install` that moves the package changes nothing a start runs. The
 * first fresh start on a machine pins the checkout's install. When the checkout
 * declares another one, the start says so and keeps the pinned binaries: the
 * switch is `./equin deps pin postgres-binaries`, on purpose.
 *
 * Imported lazily by `start.ts`: a release's compiled `pg-start` is handed
 * its vendored binaries and never reaches the deps engine.
 */
export async function pinnedBinDir(): Promise<PinnedBinDir> {
  const pinned = await pinnedDep(postgresBinaries, cliExecContext(), {
    log: (line) => console.log(`pg: ${line}`),
  });
  const ready: Ready<PackageCopySource> = pinned.ready;
  const version = await packageCopyVersion(ready);
  console.log(
    `pg: ${pinned.adopted ? "pinned" : "running the pinned"} ${postgresBinaries.id} ${ready.identity} (${version})`,
  );
  switch (pinned.drift.kind) {
    case "same":
      break;
    case "differs":
      console.log(
        `pg: the checkout declares ${postgresBinaries.id} ${pinned.drift.checkout}, not the pinned ${ready.identity} — ` +
          `keeping the pinned binaries; switch with \`./equin deps pin ${postgresBinaries.id}\`, then restart the cluster`,
      );
      break;
    case "failed":
      console.log(
        `pg: cannot tell which ${postgresBinaries.id} the checkout declares (${pinned.drift.message}); keeping the pinned binaries`,
      );
      break;
  }
  return {
    binDir: join(packageCopyDir(ready), "native", "bin"),
    markRunning: () => holdRunningDep(ready),
  };
}
