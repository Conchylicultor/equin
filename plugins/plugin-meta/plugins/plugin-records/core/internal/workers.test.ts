import { afterEach, describe, expect, test } from "bun:test";
import {
  defineRecordJob,
  installRecordWorkers,
  recordWorkerCount,
  runRecordJobRequest,
  runRecordJobs,
  type RecordJobRequest,
} from "./workers";

const calls: number[] = [];
const double = defineRecordJob<number, number>(
  import.meta.url,
  "double",
  async (n) => {
    calls.push(n);
    return n * 2;
  },
);

afterEach(() => {
  installRecordWorkers(undefined);
  calls.length = 0;
});

describe("record jobs", () => {
  test("without a pool, every request runs in-process, in order", async () => {
    expect(recordWorkerCount()).toBe(1);
    expect(await runRecordJobs(double, [1, 2, 3])).toEqual([2, 4, 6]);
    expect(calls).toEqual([1, 2, 3]);
  });

  test("a pool gets each request by job id; replies keep request order", async () => {
    const sent: RecordJobRequest[] = [];
    installRecordWorkers({
      size: 3,
      run: async (req) => {
        sent.push(req);
        return runRecordJobRequest(req, (m) => import(m));
      },
    });
    expect(recordWorkerCount()).toBe(3);
    expect(await runRecordJobs(double, [5, 6])).toEqual([10, 12]);
    expect(sent.map((r) => r.id)).toEqual([double.id, double.id]);
  });

  test("a single request stays in-process even with a pool", async () => {
    installRecordWorkers({
      size: 3,
      run: () => Promise.reject(new Error("must not be called")),
    });
    expect(await runRecordJobs(double, [7])).toEqual([14]);
  });

  test("a job id is defined once", () => {
    expect(() =>
      defineRecordJob(import.meta.url, "double", async () => 0),
    ).toThrow("defined twice");
  });

  test("a request naming a job its module does not define throws", () => {
    expect(
      runRecordJobRequest(
        { id: `${import.meta.url}#nope`, request: 1 },
        (m) => import(m),
      ),
    ).rejects.toThrow('defines no record job "nope"');
  });
});
