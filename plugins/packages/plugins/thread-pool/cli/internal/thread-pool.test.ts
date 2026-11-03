import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThreadPool } from "./thread-pool";

// Worker modules written at runtime: each imports `serveThreadPool` from this
// file's sibling by absolute path, so no fixture file ships in the plugin.
const dir = mkdtempSync(join(tmpdir(), "thread-pool-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const self = join(import.meta.dir, "thread-pool.ts");
const workerModule = (name: string, body: string): string => {
  const file = join(dir, `${name}.ts`);
  writeFileSync(
    file,
    `import { serveThreadPool } from ${JSON.stringify(self)};\n` +
      `import { threadId } from "node:worker_threads";\n${body}\n`,
  );
  return file;
};

// A promise's outcome as a value: its result, or the message it rejected with.
const outcome = <T>(p: Promise<T>): Promise<T | string> =>
  p.then(
    (v) => v,
    (err: Error) => `rejected: ${err.message}`,
  );

const echo = workerModule(
  "echo",
  `serveThreadPool(async (n: number) => {
    // Busy long enough that requests overlap.
    const until = Date.now() + 30;
    while (Date.now() < until) {}
    return { n, threadId };
  });`,
);

describe("createThreadPool", () => {
  test("answers every request, on at most `size` threads", async () => {
    const pool = createThreadPool<number, { n: number; threadId: number }>({
      url: echo,
      size: 2,
      name: "test-echo",
    });
    const replies = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => pool.run(n)),
    );
    await pool.close();
    expect(replies.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6]);
    const threads = new Set(replies.map((r) => r.threadId));
    expect(threads.size).toBe(2);
  });

  test("a throwing handler rejects that request with the worker's message, and the pool goes on", async () => {
    const file = workerModule(
      "throws",
      `serveThreadPool(async (n: number) => {
        if (n === 2) throw new Error("bad input 2");
        return n * 10;
      });`,
    );
    const pool = createThreadPool<number, number>({
      url: file,
      size: 1,
      name: "test-throws",
    });
    expect(await outcome(pool.run(2))).toBe("rejected: bad input 2");
    expect(await pool.run(3)).toBe(30);
    await pool.close();
  });

  test("a dying worker rejects the request it held and is replaced", async () => {
    const file = workerModule(
      "dies",
      `serveThreadPool(async (n: number) => {
        if (n === 0) process.exit(3);
        return n + 1;
      });`,
    );
    const pool = createThreadPool<number, number>({
      url: file,
      size: 1,
      name: "test-dies",
    });
    expect(await outcome(pool.run(0))).toMatch(/^rejected: .*test-dies/);
    expect(await pool.run(1)).toBe(2);
    await pool.close();
  });

  test("close rejects what is still queued, and later runs", async () => {
    const pool = createThreadPool<number, { n: number }>({
      url: echo,
      size: 1,
      name: "test-close",
    });
    // Outcomes captured before close() rejects, so no rejection goes unhandled.
    const first = outcome(pool.run(1));
    const queued = outcome(pool.run(2));
    await pool.close();
    expect(await first).toMatch(/closed/);
    expect(await queued).toMatch(/closed/);
    expect(await outcome(pool.run(3))).toMatch(/^rejected: .*closed/);
  });

  test("size must be a positive integer", () => {
    expect(() =>
      createThreadPool({ url: echo, size: 0, name: "test-size" }),
    ).toThrow(/size/);
  });
});
