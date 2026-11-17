import { join } from "node:path";
import { cliExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/cli";
import { holdRunningDep, pinnedDep } from "@plugins/infra/plugins/deps/deps";
import {
  packageCopyDir,
  packageCopyVersion,
} from "@plugins/infra/plugins/deps/plugins/package-copy/deps";
import { pgbouncerBinary } from "@plugins/database/plugins/pgbouncer/plugins/binary/deps";

/** The pinned binary, and how to record that the daemon now runs it. */
export interface PinnedBinary {
  binary: string;
  /** Hold the install as the one the launched daemon runs (only after a fresh start). */
  markRunning(): Promise<void>;
}

/**
 * PgBouncer's binary on a machine with a checkout: the install the pin holds
 * (`pgbouncer-binary`), never the checkout's `node_modules` — so a `bun
 * install` that moves the package changes nothing a start runs. The first
 * fresh start on a machine pins the checkout's install. When the checkout declares
 * another one, the start says so and keeps the pinned binary: the switch is
 * `./equin deps pin pgbouncer-binary`, on purpose.
 *
 * Imported lazily by `start.ts`: a release's compiled `pgbouncer-start` is
 * handed its vendored binary and never reaches the deps engine.
 */
export async function pinnedBinary(): Promise<PinnedBinary> {
  const pinned = await pinnedDep(pgbouncerBinary, cliExecContext(), {
    log: (line) => console.log(`pgbouncer: ${line}`),
  });
  const { ready } = pinned;
  const version = await packageCopyVersion(ready);
  console.log(
    `pgbouncer: ${pinned.adopted ? "pinned" : "running the pinned"} ${pgbouncerBinary.id} ${ready.identity} (${version})`,
  );
  switch (pinned.drift.kind) {
    case "same":
      break;
    case "differs":
      console.log(
        `pgbouncer: the checkout declares ${pgbouncerBinary.id} ${pinned.drift.checkout}, not the pinned ${ready.identity} — ` +
          `keeping the pinned binary; switch with \`./equin deps pin ${pgbouncerBinary.id}\`, then restart PgBouncer`,
      );
      break;
    case "failed":
      console.log(
        `pgbouncer: cannot tell which ${pgbouncerBinary.id} the checkout declares (${pinned.drift.message}); keeping the pinned binary`,
      );
      break;
  }
  return {
    binary: join(packageCopyDir(ready), "native", "bin", "pgbouncer"),
    markRunning: () => holdRunningDep(ready),
  };
}
