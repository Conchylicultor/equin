import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPooledRecordWorkers } from "./record-workers";

// A job module written at runtime, defining its job through the same core
// module (by absolute path) the worker entry imports — so no fixture ships.
// Its realpath: a module's `import.meta.url` (its job's id) is the runtime's
// spelling, and macOS's tmpdir is a symlink.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "record-workers-test-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const workers = join(import.meta.dir, "../../core/internal/workers.ts");
const jobFile = join(dir, "jobs.ts");
writeFileSync(
  jobFile,
  `import { defineRecordJob } from ${JSON.stringify(workers)};
import { threadId } from "node:worker_threads";
// Module state: what this realm has seen.
const seen: number[] = [];
defineRecordJob(import.meta.url, "remember", async (n: number) => {
  seen.push(n);
  return { threadId, seen: [...seen] };
});
defineRecordJob(import.meta.url, "fail", async () => {
  throw new Error("job failed on purpose");
});
`,
);
const jobUrl = pathToFileURL(jobFile).href;

type Reply = { threadId: number; seen: number[] };

describe("createPooledRecordWorkers", () => {
  test("runs a job in a worker thread, importing its module there", async () => {
    const pool = createPooledRecordWorkers({ threads: 2 });
    try {
      const r = (await pool.run({
        id: `${jobUrl}#remember`,
        request: 1,
      })) as Reply;
      expect(r.threadId).toBeGreaterThan(0);
      expect(r.seen).toEqual([1]);
    } finally {
      await pool.close();
    }
  });

  test("a worker keeps its realm across requests (its JIT stays warm)", async () => {
    const pool = createPooledRecordWorkers({ threads: 1 });
    try {
      await pool.run({ id: `${jobUrl}#remember`, request: 1 });
      const again = (await pool.run({
        id: `${jobUrl}#remember`,
        request: 2,
      })) as Reply;
      expect(again.seen).toEqual([1, 2]);
    } finally {
      await pool.close();
    }
  });

  test("a failing job rejects with its message", async () => {
    const pool = createPooledRecordWorkers({ threads: 1 });
    try {
      expect(pool.run({ id: `${jobUrl}#fail`, request: null })).rejects.toThrow(
        "job failed on purpose",
      );
    } finally {
      await pool.close();
    }
  });
});
