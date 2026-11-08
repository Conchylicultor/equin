import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import type { OwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { getMainRepoRoot } from "@plugins/infra/plugins/spawn/core";
import { isReportKindRegistered } from "@plugins/reports/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { repositoryOf } from "../../core";
import { reportOutboxDir } from "../../data-dirs";
import { drainOutbox, type DrainDeps } from "./drain";
import {
  acquireDrainerLock,
  DRAINER_LOCK_NAME,
  releaseDrainerLock,
} from "./drainer-lock";
import { checkStaleness } from "./staleness";

export const reportOutboxWatcher = defineFileWatcher({
  name: "reports-outbox.outbox-dir",
  description:
    "Watches the host-global report outbox and files every report a CLI run or supervised child dropped there.",
  mainOnly: true,
});

async function productionDeps(): Promise<DrainDeps> {
  const root = await getMainRepoRoot(REPO_ROOT);
  return {
    dir: reportOutboxDir.path,
    repo: await repositoryOf(REPO_ROOT),
    record: async (entry) => {
      await recordReport({
        kind: entry.kind,
        source: "cli",
        message: entry.message,
        data: entry.data,
        occurredAt: entry.occurredAt,
        // The writer's code, never main's own (an absent field: unknown).
        commit: entry.writer.commit ?? null,
      });
    },
    recordFailure: async (error) => {
      await recordReport({
        kind: "crash",
        source: "server-caught",
        message: error.message,
        data: crashFieldsOf(error),
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

/** This process's turn as the drainer — see `acquireDrainerLock`. */
interface DrainerSession {
  abort: AbortController;
  /** Waits for the lock, then subscribes and drains. */
  started: Promise<void>;
  lock: OwnedFd | null;
  watcher: FileWatcher | null;
}

let session: DrainerSession | null = null;

/**
 * Start draining the report outbox once this process is THE drainer: once on
 * taking the role (whatever piled up meanwhile), then on every change in the
 * directory. No timer — a write IS the signal.
 *
 * Main-only: the outbox is host-global, and a worktree backend draining it
 * would file every report under its own namespace. And one main backend at a
 * time: across a deploy the successor waits for the drainer lock its
 * predecessor releases on shutdown (or by dying) — two drainers would both
 * record an entry, and the slower one's delete would fail.
 *
 * Not awaited by `onReady`: the wait lasts until the predecessor exits, which
 * must not hold this backend's ready phases. A failure to take the role
 * rejects `started` unhandled — a loud server report, never a silent
 * non-drainer.
 */
export function startReportOutbox(): void {
  if (!isMain()) return;
  if (session) return;
  const abort = new AbortController();
  const current: DrainerSession = {
    abort,
    started: Promise.resolve(),
    lock: null,
    watcher: null,
  };
  current.started = becomeDrainer(current);
  session = current;
}

async function becomeDrainer(current: DrainerSession): Promise<void> {
  const dir = reportOutboxDir.ensure();
  const { signal } = current.abort;
  try {
    current.lock = await acquireDrainerLock(
      reportOutboxDir.file(DRAINER_LOCK_NAME),
      signal,
    );
  } catch (error) {
    // Shut down while still waiting: never was the drainer, nothing to undo.
    if (signal.aborted) return;
    throw error;
  }
  current.watcher = await reportOutboxWatcher.start({
    dirs: [dir],
    onChange: () => drains.run(),
  });
  // After subscribing, so an entry written between the first pass's listing
  // and the subscription is not missed.
  drains.trigger();
}

/**
 * Give up the drainer role: stop listening, let the pass in flight finish (it
 * may be halfway through an entry), and only then release the lock — the
 * successor's first pass must not overlap ours.
 */
export async function stopReportOutbox(): Promise<void> {
  const current = session;
  if (!current) return;
  session = null;
  current.abort.abort();
  try {
    await current.started;
  } finally {
    if (current.watcher) await current.watcher.stop();
    await drains.idle();
    if (current.lock) releaseDrainerLock(current.lock);
  }
}
