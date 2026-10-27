import { describeHistoryContract } from "@plugins/apps/plugins/prototypes/plugins/files/server/testing";
import { createMemoryDataFiles } from "@plugins/infra/plugins/paths/plugins/data-files/plugins/memory/server/testing";
import {
  SNAPSHOT_HISTORY_FORMAT,
  openSnapshotHistoryStore,
} from "./snapshot-store";

// The snapshot store against the contract every history provider passes, over
// a fresh memory root per test — the store a browser host boots.

describeHistoryContract("snapshots", async () => {
  const files = createMemoryDataFiles().root({
    id: "apps.prototypes",
    dir: "apps/prototypes",
    watch: {
      name: "snapshot-history.test",
      description: "Hears the suite's writes.",
    },
  });
  return {
    history: openSnapshotHistoryStore(files),
    files,
    format: SNAPSHOT_HISTORY_FORMAT,
    dispose: async () => {},
  };
});
