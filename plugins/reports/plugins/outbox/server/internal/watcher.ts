import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import { isReportKindRegistered } from "@plugins/reports/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { reportOutboxDir } from "../../data-dirs";
import { drainOutbox, type DrainDeps } from "./drain";
import { checkStaleness } from "./staleness";

export const reportOutboxWatcher = defineFileWatcher({
  name: "reports-outbox.outbox-dir",
  description:
    "Watches the host-global report outbox and files every report a CLI run or supervised child dropped there.",
  mainOnly: true,
});

let watcher: FileWatcher | null = null;

async function productionDeps(): Promise<DrainDeps> {
  const root = await getMainRepoRoot(REPO_ROOT);
  return {
    dir: reportOutboxDir.path,
    record: async (entry) => {
      await recordReport({
        kind: entry.kind,
        source: "cli",
        message: entry.message,
        data: entry.data,
        occurredAt: entry.occurredAt,
      });
    },
    recordFailure: async (error) => {
      await recordReport({
        kind: "crash",
        source: "server-caught",
        message: error.message,
        data: { errorType: error.name, stack: error.stack ?? null },
      });
    },
    isKnownKind: isReportKindRegistered,
    checkStaleness: (code) => checkStaleness(code, { root, mainRef: "main" }),
    log: (line) => console.warn(line),
  };
}

// Passes are serialized: two overlapping passes would both read an entry
// before either deleted it, and record it twice. A write landing mid-pass (the
// pass in flight listed the directory before it) is owed one more pass. The
// drain turns every per-entry failure into a report itself, so anything
// escaping is unexpected and surfaces as an unhandled rejection — without
// disarming later passes.
const drains = createCoalescer({
  run: () =>
    runTracked("report-outbox:drain", async () =>
      drainOutbox(await productionDeps()),
    ),
});

/**
 * Start draining the report outbox: once now (whatever piled up while main was
 * down), then on every change in the directory. No timer — a write IS the
 * signal.
 *
 * Main-only: the outbox is host-global, and one reader is the whole design. A
 * worktree backend draining it too would race main for the same entries and
 * file every report under its own namespace.
 */
export async function startReportOutbox(): Promise<void> {
  if (!isMain()) return;
  if (watcher) return;
  const dir = reportOutboxDir.ensure();
  watcher = await reportOutboxWatcher.start({
    dirs: [dir],
    onChange: () => drains.run(),
  });
  // After subscribing, so an entry written between the first pass's listing
  // and the subscription is not missed.
  drains.trigger();
}

export async function stopReportOutbox(): Promise<void> {
  if (!watcher) return;
  await watcher.stop();
  watcher = null;
}
