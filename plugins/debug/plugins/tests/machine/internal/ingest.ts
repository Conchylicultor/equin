import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { db } from "@plugins/database/server";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import {
  defineFileWatcher,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import {
  TEST_RUN_RECORD_VERSION,
  TestRunRecordSchema,
  testRunRecordOpId,
} from "@plugins/framework/plugins/cli/plugins/test/plugins/record/core";
import { testRunRecordsDir } from "@plugins/framework/plugins/cli/plugins/test/data-dirs";
import { ingestedOpIds, ingestRunRecord } from "../../server";

// The harvest's ingest on THIS backend: every `./equin test` run on the host
// leaves a record in the host-global records dir; each serving backend reads
// the ones its database has not seen into its own tables. One serialized pass
// at boot, on every change in the dir, and when the watch reports lost events.
// Every backend (not one drainer): a worktree's page shows real data while it
// is developed, with no lock and no delete to race.

export const testRunRecordsWatcher = defineFileWatcher({
  name: "tests.run-records",
  description:
    "Watches the host-global test-run records and ingests each new one into this backend's test-status tables.",
  extensions: [".json"],
});

// A record that is not one is reported once per process, not on every pass.
const reportedBad = new Set<string>();

export type IngestPassResult = {
  ingested: number;
  skipped: number;
  malformed: number;
};

/**
 * One pass over `dir`: every record whose opId this database has no run for
 * is parsed and ingested (one transaction each). A record of an unknown
 * version is left for a newer reader; a malformed one is an infrastructure
 * error, reported once — never a test failure.
 */
export async function ingestPass(dir: string): Promise<IngestPassResult> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { ingested: 0, skipped: 0, malformed: 0 };
    throw err;
  }
  const byOpId = new Map<string, string>();
  for (const name of names) {
    const opId = testRunRecordOpId(name);
    if (opId !== null) byOpId.set(opId, name);
  }
  const seen = await ingestedOpIds(db, [...byOpId.keys()]);
  const result: IngestPassResult = { ingested: 0, skipped: 0, malformed: 0 };
  for (const [opId, name] of byOpId) {
    if (seen.has(opId)) continue;
    const path = join(dir, name);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      // Pruned between the listing and the read: nothing to ingest.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      malformed(path, err.message);
      result.malformed++;
      continue;
    }
    if (
      typeof json === "object" &&
      json !== null &&
      (json as { v?: unknown }).v !== TEST_RUN_RECORD_VERSION
    ) {
      result.skipped++;
      continue;
    }
    const parsed = TestRunRecordSchema.safeParse(json);
    if (!parsed.success) {
      malformed(path, parsed.error.message);
      result.malformed++;
      continue;
    }
    if (await ingestRunRecord(db, parsed.data)) result.ingested++;
  }
  return result;
}

function malformed(path: string, why: string): void {
  if (reportedBad.has(path)) return;
  reportedBad.add(path);
  reportServerError({
    message: `[tests] malformed test-run record ${path}: ${why.slice(0, 500)}`,
    scope: "tests.run-records",
  });
}

let watcher: FileWatcher | null = null;
const passes = createCoalescer({
  run: () =>
    runTracked("tests:ingest-pass", async () => {
      await ingestPass(testRunRecordsDir.path);
    }),
});

/**
 * Ingest every record not yet in this database, now — joining a pass already
 * running, or running one more after it. For work that must see a run's
 * verdicts before its next step (the idle runner picks its next batch by
 * status).
 */
export function ingestRunRecordsNow(): Promise<void> {
  return passes.run();
}

/** Boot: one pass (awaited), then watch; a write between the two is caught by the pass after subscribing. */
export async function startIngest(): Promise<void> {
  if (watcher) return;
  await passes.run();
  const dir = await testRunRecordsDir.ensure();
  watcher = await testRunRecordsWatcher.start({
    dirs: [dir],
    onChange: () => passes.run(),
    onLost: () => passes.run(),
  });
  passes.trigger();
}

export async function stopIngest(): Promise<void> {
  if (!watcher) return;
  await watcher.stop();
  watcher = null;
}
