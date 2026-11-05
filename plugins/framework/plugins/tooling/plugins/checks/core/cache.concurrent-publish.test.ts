/**
 * Concurrency contract for the cache's atomic publish.
 *
 * The regression under test: the temp file used to be named
 * `sha256(destination)`, so every process publishing the same slot picked the
 * BYTE-IDENTICAL temp path. Two builds racing over one slot then lose both ways
 * — one truncates the other's half-written bytes, and whichever renames second
 * dies on ENOENT because the first rename already consumed the temp. That
 * ENOENT propagates out of `runChecks` and aborts the build.
 *
 * This is reachable in normal operation: `CACHE_DIR` is global (deliberately, so
 * main can reuse an agent worktree's passes) and a legacy slot is keyed on the
 * tree hash alone, so two worktrees on the same tree (a fresh claim of main,
 * main's own auto-build) publish the same slot; two runs in one checkout share
 * its read-set slot (`(checkId, sig, checkout)`, NO treeHash).
 *
 * Uses REAL subprocesses, not in-process interleaving: the failure is a rename
 * race between OS processes, and a single-threaded simulation of it would prove
 * nothing about the fix.
 */

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "cache-publish-"));
  dirs.push(d);
  return d;
}

// Mirrors `publishAtomic` in ./cache.ts. Inlined rather than imported because
// the worker runs as a separate process and the real helper is module-private;
// the invariant under test is the temp-naming scheme, which this reproduces
// exactly.
const WORKER = `
const { writeFileSync, renameSync, rmSync } = require("fs");
const { dirname, join } = require("path");
const { randomUUID } = require("crypto");
const [file, payload, rounds] = [process.argv[2], process.argv[3], Number(process.argv[4])];
for (let i = 0; i < rounds; i++) {
  const tmp = join(dirname(file), "." + process.pid + "-" + randomUUID() + ".tmp");
  try {
    writeFileSync(tmp, payload);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}
`;

// The pre-fix scheme, kept as the control: proves the test harness actually
// drives the collision hard enough to trip it.
const LEGACY_WORKER = `
const { writeFileSync, renameSync } = require("fs");
const { createHash } = require("crypto");
const { join, dirname } = require("path");
const [file, payload, rounds] = [process.argv[2], process.argv[3], Number(process.argv[4])];
const tmp = join(dirname(file), "." + createHash("sha256").update(file).digest("hex").slice(0, 12) + ".tmp");
for (let i = 0; i < rounds; i++) {
  writeFileSync(tmp, payload);
  renameSync(tmp, file);
}
`;

async function race(
  source: string,
  file: string,
  workers: number,
  rounds: number,
): Promise<{ failures: string[] }> {
  // A real script file, not `bun -e`: with `-e` there is no script slot in
  // `process.argv`, so the worker's argv indices would silently shift and the
  // loop would never run — a green test proving nothing.
  const script = join(scratch(), "worker.js");
  writeFileSync(script, source);
  const procs = Array.from({ length: workers }, (_, i) =>
    Bun.spawn(["bun", script, file, `payload-${i}`.repeat(2000), String(rounds)], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const failures: string[] = [];
  await Promise.all(
    procs.map(async (p) => {
      const err = await new Response(p.stderr).text();
      await p.exited;
      // Full stderr, not just the first line — bun leads its error report with a
      // source-context excerpt, so the first line is never the message.
      if (p.exitCode !== 0) failures.push(err.trim() || "(no stderr)");
    }),
  );
  return { failures };
}

test("concurrent publishers of the same slot never collide", async () => {
  const dir = scratch();
  const file = join(dir, "slot.readset.json");

  const { failures } = await race(WORKER, file, 8, 40);
  expect(failures).toEqual([]);

  // The winner's payload is complete — never a torn interleaving of two writers.
  const published = readFileSync(file, "utf8");
  expect(published).toMatch(/^(payload-\d)+$/);
  expect(new Set(published.match(/payload-\d/g))).toHaveLength(1);

  // Every temp was reclaimed; none leaked into the cache dir.
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
}, 30_000);

test("the destination-derived temp name is what caused the ENOENT", async () => {
  const dir = scratch();
  const file = join(dir, "slot.readset.json");

  // Control: the pre-fix naming, driven the same way, must actually fail —
  // otherwise the test above passes vacuously.
  const { failures } = await race(LEGACY_WORKER, file, 8, 40);
  expect(failures.length).toBeGreaterThan(0);
  expect(failures.join("\n")).toContain("ENOENT");
}, 30_000);
