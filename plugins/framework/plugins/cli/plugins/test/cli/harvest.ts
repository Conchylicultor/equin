import { renameSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { repoSnapshotNow } from "@plugins/framework/plugins/tooling/core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { openRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";
import {
  TEST_DIGEST_VERSION,
  testDigests,
} from "@plugins/framework/plugins/cli/plugins/test/plugins/digest/core";
import {
  fileResults,
  type JunitSummary,
  type TestRunnerName,
} from "@plugins/framework/plugins/cli/plugins/test/core";
import {
  TEST_RUN_RECORD_RETENTION_DAYS,
  TEST_RUN_RECORD_VERSION,
  TestRunOriginSchema,
  testRunRecordFileName,
  type TestRunOrigin,
  type TestRunRecord,
} from "@plugins/framework/plugins/cli/plugins/test/plugins/record/core";
import { testRunRecordsDir } from "../data-dirs";

// A wedge-breaker for one metadata read, not a latency budget.
const GIT_TIMEOUT_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The harvest's half of a test run (`./equin test` feeding Debug → Tests):
 * digests taken BEFORE the runners start, a record written AFTER the verdict.
 * Nothing here may fail the run: every failure is one loud line and the
 * harvest is skipped, while the tests' own verdict stands.
 */
export interface HarvestStart {
  origin: TestRunOrigin;
  digests: Map<string, string>;
  startedAt: string;
}

/** Who started this run: `EQUIN_TEST_ORIGIN`, unset = an agent typed it. */
function readOrigin(): TestRunOrigin {
  const raw = readEnv("TEST_ORIGIN");
  if (raw === undefined) return "agent";
  return TestRunOriginSchema.parse(raw);
}

function harvestFailed(what: string, err: unknown): void {
  const reason =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(
    `\n!! test harvest: ${what} — this run's verdicts will NOT reach Debug → Tests (the tests still run):\n${reason}`,
  );
}

/**
 * Digest every file the run will test (`test/plugins/digest`), before the op:
 * sequential, before any runner starts, so no file changes mid-graph. Prints
 * its time — the one cost the harvest adds to a run. `ok: false` when it
 * failed (said loudly): the run goes on unharvested.
 */
export async function startHarvest(
  root: AppPath,
  files: readonly string[],
): Promise<{ ok: true; start: HarvestStart } | { ok: false }> {
  try {
    const startedAt = new Date().toISOString();
    const origin = readOrigin();
    const t0 = performance.now();
    const store = openRecordStore();
    const snapshot = await repoSnapshotNow(root);
    const digests = await testDigests(snapshot, store, files);
    await store.flush();
    console.log(
      `(test digests: ${files.length} file${files.length === 1 ? "" : "s"} in ${Math.round(performance.now() - t0)} ms)`,
    );
    return {
      ok: true,
      start: {
        origin,
        startedAt,
        digests: new Map([...digests].map(([f, d]) => [f, d.digest])),
      },
    };
  } catch (err) {
    harvestFailed("digesting failed", err);
    return { ok: false };
  }
}

/** One runner, as the harvest sees it once it has run. */
export interface HarvestRunner {
  runner: TestRunnerName;
  files: readonly string[];
  exitCode: number;
  wedged: boolean;
  report: JunitSummary | null;
}

/**
 * Write the run's harvest record (leader only — a run that adopted another's
 * verdict never calls this). Skipped when the tree moved during the run: its
 * results would be filed under digests of code it may not have run.
 */
export async function finishHarvest(opts: {
  start: HarvestStart;
  root: AppPath;
  slug: string;
  opId: string;
  treeHashBefore: string | null;
  treeHashAfter: () => Promise<string | null>;
  runners: readonly HarvestRunner[];
}): Promise<void> {
  try {
    const { start } = opts;
    if (opts.treeHashBefore === null) {
      console.error(
        "\n!! test harvest: no tree hash for this checkout — nothing harvested",
      );
      return;
    }
    const after = await opts.treeHashAfter();
    if (after !== opts.treeHashBefore) {
      console.log(
        "(test harvest skipped: the checkout changed while the tests ran)",
      );
      return;
    }
    const files: TestRunRecord["files"] = [];
    const failures: TestRunRecord["failures"] = [];
    const runners: TestRunRecord["runners"] = [];
    for (const r of opts.runners) {
      const h = fileResults({ ...r, digests: start.digests });
      files.push(...h.files);
      failures.push(...h.failures);
      runners.push({
        runner: r.runner,
        exitCode: r.exitCode,
        files: r.files.length,
        unattributed: h.unattributed,
      });
    }
    const rev = await spawnCaptured(["git", "rev-parse", "HEAD"], {
      cwd: opts.root,
      env: process.env,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const record: TestRunRecord = {
      v: TEST_RUN_RECORD_VERSION,
      opId: opts.opId,
      repo: opts.root,
      slug: opts.slug,
      origin: start.origin,
      head: rev.exitCode === 0 ? rev.stdout.trim() : null,
      treeHash: opts.treeHashBefore,
      startedAt: start.startedAt,
      finishedAt: new Date().toISOString(),
      digestVersion: TEST_DIGEST_VERSION,
      runners,
      files,
      failures,
    };
    const dir = testRunRecordsDir.ensureSync();
    const path = join(dir, testRunRecordFileName(opts.opId));
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record) + "\n");
    renameSync(tmp, path);
    pruneRecords(dir);
  } catch (err) {
    harvestFailed("writing the record failed", err);
  }
}

/** Drop records past their retention: writing a new one is what prunes old ones. */
function pruneRecords(dir: string): void {
  const cutoff = Date.now() - TEST_RUN_RECORD_RETENTION_DAYS * DAY_MS;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
  }
}
