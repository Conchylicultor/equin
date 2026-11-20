import { getTableName } from "drizzle-orm";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { DatabaseDriver, type ListenSession } from "@plugins/database/server";
import { defineDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { _deployServers } from "@plugins/apps/plugins/deploy/plugins/servers/server";
import { serverHealth } from "@plugins/apps/plugins/deploy/plugins/health/server";
import { deployHostStandIns } from "@plugins/apps/plugins/deploy/plugins/host-query/server";

// What the link reaches is decided by four tables other plugins write: the
// deployments (which box, which port), the servers (address, user, public
// key), their health side-table (the pinned host key, written by every
// connection check — so a replaced key, verified again, lands here too) and
// the stand-in marks. A statement-level trigger on each NOTIFYs one channel;
// the link re-reads its targets and restarts only what changed. Push-based:
// nothing re-reads on a timer.

/** The channel every write to a link-target table rings. */
export const BOX_LINK_TARGETS_CHANNEL = "box_link_targets";

const FUNCTION = "box_link_targets_changed";

const TARGET_TABLES = [
  getTableName(_deployDeployments),
  getTableName(_deployServers),
  getTableName(serverHealth.table),
  getTableName(deployHostStandIns),
];

export const boxLinkTargetTriggers = defineDbTriggers({
  id: "box-link.targets",
  functions: [
    {
      name: FUNCTION,
      args: "",
      ddl: `CREATE OR REPLACE FUNCTION ${FUNCTION}() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('${BOX_LINK_TARGETS_CHANNEL}', '');
  RETURN NULL;
END
$$`,
    },
  ],
  triggers: TARGET_TABLES.map((table) => ({
    name: "box_link_targets_changed",
    table,
    ddl: `CREATE OR REPLACE TRIGGER box_link_targets_changed
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${table}
  FOR EACH STATEMENT EXECUTE FUNCTION ${FUNCTION}()`,
  })),
});

/**
 * Call `fn` whenever a link-target table was written (once per committing
 * transaction — Postgres folds the identical notices), and once more after a
 * lost LISTEN session is open again (a notice may have been missed).
 * Resolves to the stop once the LISTEN is active: a read made after it
 * cannot miss a change committed meanwhile. One session per call — the link
 * manager is its one subscriber.
 */
export async function onLinkTargetsChanged(
  fn: () => void,
): Promise<() => void> {
  let stopped = false;
  let session: ListenSession | null = null;
  async function open(): Promise<void> {
    const opened = await DatabaseDriver.get().listen(
      "box-link-targets",
      [BOX_LINK_TARGETS_CHANNEL],
      {
        notification: () => fn(),
        lost: () => {
          session = null;
          if (stopped) return;
          void runTracked("box-link: reopen the targets LISTEN", async () => {
            await open();
            fn();
          });
        },
      },
    );
    if (stopped) {
      await opened.close();
      return;
    }
    session = opened;
  }
  await open();
  return () => {
    stopped = true;
    const closing = session;
    session = null;
    if (closing !== null) {
      void runTracked("box-link: close the targets LISTEN", () =>
        closing.close(),
      );
    }
  };
}
