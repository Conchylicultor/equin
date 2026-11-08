// Measures how long opening and closing a single-directory watch holds the JS
// thread, for the two backends a `children` watch has had on macOS: Bun's
// `fs.watch` (until 2026-11-08) and a parcel FSEvents subscription (since).
// Each round opens `--watches` watches of fresh dirs, then closes them, timing
// every call synchronously (for parcel: until the call returns its promise —
// the native work runs on a worker thread) and the event loop's worst lag
// meanwhile. `--churn` keeps a writer busy in another dir so fseventsd has
// work, as on a loaded host.
//
//   ./equin run plugins/infra/plugins/file-watcher/scripts/measure-watch-blocking.ts \
//     [--rounds 5] [--watches 20] [--churn]
//
// Research: research/2026-11-08-infra-file-watcher-close-stall.md
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getParcelWatcher } from "../shared/engine";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const rounds = flag("rounds", 5);
const watches = flag("watches", 20);
const churn = argv.includes("--churn");

interface Stats {
  open: number[];
  close: number[];
  lag: number;
}

function summary(name: string, xs: number[]): string {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number =>
    s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  const total = s.reduce((a, b) => a + b, 0);
  return `${name}: n=${s.length} median=${at(0.5).toFixed(2)}ms p95=${at(0.95).toFixed(2)}ms max=${(s.at(-1) ?? 0).toFixed(2)}ms total=${total.toFixed(1)}ms`;
}

/** The event loop's worst lag while `work` runs, from a 5 ms timer chain. */
async function withLagProbe(work: () => Promise<void>): Promise<number> {
  let worst = 0;
  let running = true;
  const arm = (): void => {
    const expected = performance.now() + 5;
    setTimeout(() => {
      worst = Math.max(worst, performance.now() - expected);
      if (running) arm();
    }, 5);
  };
  arm();
  await work();
  running = false;
  return worst;
}

async function measure(
  root: string,
  backend: "fs-watch" | "parcel",
): Promise<Stats> {
  const parcel = await getParcelWatcher();
  const stats: Stats = { open: [], close: [], lag: 0 };
  for (let r = 0; r < rounds; r++) {
    const dirs: string[] = [];
    for (let i = 0; i < watches; i++) {
      const d = join(root, `${backend}-${r}-${i}`);
      await mkdir(d);
      dirs.push(d);
    }
    const lag = await withLagProbe(async () => {
      const closers: (() => Promise<void>)[] = [];
      for (const d of dirs) {
        if (backend === "fs-watch") {
          const t = performance.now();
          const w = fsWatch(d, { persistent: false }, () => {});
          stats.open.push(performance.now() - t);
          closers.push(async () => {
            const c = performance.now();
            w.close();
            stats.close.push(performance.now() - c);
          });
        } else {
          const t = performance.now();
          const p = parcel.subscribe(d, () => {}, { ignore: [/\//] });
          stats.open.push(performance.now() - t);
          const sub = await p;
          closers.push(async () => {
            const c = performance.now();
            const q = sub.unsubscribe();
            stats.close.push(performance.now() - c);
            await q;
          });
        }
        await new Promise((res) => setTimeout(res, 2));
      }
      for (const close of closers) {
        await close();
        await new Promise((res) => setTimeout(res, 2));
      }
    });
    stats.lag = Math.max(stats.lag, lag);
  }
  return stats;
}

const root = await mkdtemp(join(tmpdir(), "watch-blocking-"));
let churning = churn;
const writer = (async () => {
  const dir = join(root, "churn");
  await mkdir(dir);
  let n = 0;
  while (churning) {
    await writeFile(join(dir, `f${n++ % 200}`), String(n));
  }
})();
try {
  for (const backend of ["fs-watch", "parcel"] as const) {
    const s = await measure(root, backend);
    console.log(
      `\n${backend} (${rounds} rounds × ${watches} watches${churn ? ", churn" : ""})`,
    );
    console.log("  " + summary("open (JS thread)", s.open));
    console.log("  " + summary("close (JS thread)", s.close));
    console.log(`  worst event-loop lag: ${s.lag.toFixed(1)}ms`);
  }
} finally {
  churning = false;
  await writer;
  await rm(root, { recursive: true, force: true });
}
