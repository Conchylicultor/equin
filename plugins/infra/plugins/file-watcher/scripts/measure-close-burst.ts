// Measures a burst of `children` watch closes on macOS — the file explorer's
// peek pattern (2026-11-12: 59 `file-watcher.dir-entries:stop` spans of 12 s
// each, ending in the same millisecond, beside a 15.8 s `fs-stat` wait).
//
// Splits each close into what it waits for and what it does: N watches of N
// scratch folders are opened, then all closed at once while M new ones open
// (a scrolled listing), and a probe times an `fs.promises.stat` every 5 ms —
// Bun runs those on the same worker pool as parcel's napi work, so a probe
// that waits is a pool thread held by the watcher.
//
//   ./equin run plugins/infra/plugins/file-watcher/scripts/measure-close-burst.ts [--n 60] [--entries 40] [--rounds 3]
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath, stat } from "@plugins/packages/plugins/timed-fs/core";
import { createFileWatcher, type FileWatcher } from "../shared/engine";

const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? Number(argv[at + 1]) : dflt;
};
const N = arg("n", 60);
const ENTRIES = arg("entries", 40);
const ROUNDS = arg("rounds", 3);

const pct = (xs: number[], p: number): number =>
  xs.length === 0
    ? NaN
    : [...xs].sort((a, b) => a - b)[
        Math.min(xs.length - 1, Math.floor(xs.length * p))
      ]!;
const fmt = (xs: number[]): string =>
  `n=${xs.length} p50 ${pct(xs, 0.5).toFixed(1)} p90 ${pct(xs, 0.9).toFixed(1)} max ${Math.max(...xs).toFixed(1)} ms`;

async function makeDirs(root: string, prefix: string): Promise<string[]> {
  const dirs: string[] = [];
  for (let i = 0; i < N; i++) {
    const d = join(root, `${prefix}${i}`);
    await mkdir(d);
    await Promise.all(
      Array.from({ length: ENTRIES }, (_, j) =>
        writeFile(join(d, `f${j}`), "x"),
      ),
    );
    dirs.push(d);
  }
  return dirs;
}

const open = (dir: string): Promise<FileWatcher> =>
  createFileWatcher({
    dirs: [dir],
    depth: "children",
    debounceMs: 0,
    onChange: () => {},
  });

/** Times stat() of `path` back to back until stopped: what a file read waits. */
function probe(path: string): { stop(): Promise<number[]> } {
  const samples: number[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const t0 = performance.now();
      await stat(path);
      samples.push(performance.now() - t0);
      await Bun.sleep(5);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return samples;
    },
  };
}

const root = await realpath(await mkdtemp(join(tmpdir(), "close-burst-")));
try {
  for (let r = 0; r < ROUNDS; r++) {
    const a = await makeDirs(root, `r${r}a`);
    const b = await makeDirs(root, `r${r}b`);

    // 1. Each close alone: the native call itself, nothing queued ahead.
    const solo: number[] = [];
    for (const d of a.slice(0, 10)) {
      const w = await open(d);
      const t0 = performance.now();
      await w.stop();
      solo.push(performance.now() - t0);
    }

    // 2. The burst: N open, then all closed at once while N others open.
    const opened = await Promise.all(a.map(open));
    const p = probe(root);
    await Bun.sleep(50);
    const t0 = performance.now();
    const closes = opened.map(async (w) => {
      const s = performance.now();
      await w.stop();
      return { start: s - t0, end: performance.now() - t0 };
    });
    const opens = b.map(async (d) => {
      const s = performance.now();
      const w = await open(d);
      return { w, ms: performance.now() - s };
    });
    const closed = await Promise.all(closes);
    const reopened = await Promise.all(opens);
    const burstMs = performance.now() - t0;
    await Bun.sleep(50);
    const stats = await p.stop();
    await Promise.all(reopened.map((o) => o.w.stop()));

    const durs = closed.map((c) => c.end - c.start);
    const ends = closed.map((c) => c.end).sort((x, y) => x - y);
    console.log(`round ${r + 1}: N=${N} entries=${ENTRIES}`);
    console.log(`  close alone        ${fmt(solo)}`);
    console.log(`  close in burst     ${fmt(durs)}`);
    console.log(
      `  burst ends spread  first ${ends[0]!.toFixed(1)} last ${ends.at(-1)!.toFixed(1)} ms (serial queue → evenly spread; one blocker → bunched)`,
    );
    console.log(`  open in burst      ${fmt(reopened.map((o) => o.ms))}`);
    console.log(`  burst wall         ${burstMs.toFixed(1)} ms`);
    console.log(`  stat probe         ${fmt(stats)}`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
