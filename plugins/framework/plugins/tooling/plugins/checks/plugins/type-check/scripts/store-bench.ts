// ─── What does opening and evicting a type-check store cost, by its size? ────
//
//   ./equin run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/store-bench.ts \
//     [--sizes 25000,100000,200000,800000] [--dir <scratch parent>]
//
// Builds synthetic stores in a scratch directory (never the host's live
// stores) and measures, per size, user / system CPU and wall:
//
//   - FLAT (before 2026-10-27): one directory, each entry's mtime its age.
//     `open` = the readdir every open paid (sweep not due); `sweep` = the
//     hourly age sweep (stat every entry, remove the expired quarter).
//   - GENERATIONS (`../shared/pass-set.ts`): the same entries in 4
//     generations. `open` = an open inside the window; `evicting open` = the
//     open that drops the oldest generation (the same quarter of the entries:
//     renamed aside, its per-open budget unlinked); `rest` = the remaining
//     unlinks, which later opens pay a budget at a time.
//
// Both evict the same number of entries, so the difference is what each pays
// for the entries it keeps. Page cache warm (a fresh store is in memory);
// cold-cache numbers need `sudo purge` between runs, which this does not do.
// The flat store's prune is copied here as it was, the baseline.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  openPassSet,
  type PassSetBounds,
  type PassSetDir,
} from "../shared/pass-set";

const DAY = 24 * 60 * 60 * 1000;
const BOUNDS: PassSetBounds = {
  maxAgeMs: 14 * DAY,
  generations: 4,
  maxEntries: 10_000_000,
};
const PERIOD = BOUNDS.maxAgeMs / BOUNDS.generations;
const BODY = JSON.stringify({ text: "x".repeat(200), recordedAt: 0 });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const sizes = (arg("sizes") ?? "25000,100000,200000,800000")
  .split(",")
  .map(Number);
const parent = arg("dir") ?? tmpdir();

interface Cost {
  user: number;
  sys: number;
  wall: number;
}

function measure(fn: () => void): Cost {
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  fn();
  const c = process.cpuUsage(c0);
  return {
    user: c.user / 1e6,
    sys: c.system / 1e6,
    wall: (performance.now() - t0) / 1000,
  };
}

const name = (i: number): string => `${i.toString(16).padStart(64, "0")}.json`;

// ── The flat store's prune, as it was (pass-set.ts before 2026-10-27) ──────

function flatPrune(
  dir: string,
  maxAgeMs: number,
  maxEntries: number,
  trimTo: number,
  sweepDue: boolean,
  now: number,
): number {
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  if (names.length <= maxEntries && !sweepDue) return 0;
  let removed = 0;
  const live: { path: string; mtimeMs: number }[] = [];
  for (const n of names) {
    const path = join(dir, n);
    const mtimeMs = statSync(path).mtimeMs;
    if (now - mtimeMs > maxAgeMs) {
      rmSync(path, { force: true });
      removed++;
    } else live.push({ path, mtimeMs });
  }
  if (live.length > maxEntries) {
    live.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const { path } of live.slice(0, live.length - trimTo)) {
      rmSync(path, { force: true });
      removed++;
    }
  }
  return removed;
}

function buildFlat(dir: string, n: number, now: number): void {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const path = join(dir, name(i));
    writeFileSync(path, BODY);
    // Ages spread over 14 days + a quarter period past it: the last quarter
    // of the entries is expired, as one generation's worth.
    const age = ((i % 4) + 0.5) * PERIOD + (i % 4 === 3 ? PERIOD : 0);
    const t = new Date(now - age);
    utimesSync(path, t, t);
  }
}

function buildGenerations(dir: string, n: number, now: number): void {
  const cur = Math.floor(now / PERIOD);
  const home = join(dir, "generations");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".born"), String(now));
  writeFileSync(join(home, ".legacy-swept"), "");
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const gen = cur - (i % 4); // a quarter in each of the 4 generations
    const g = join(home, `g${gen}`);
    if (!counts.has(gen)) mkdirSync(g, { recursive: true });
    counts.set(gen, (counts.get(gen) ?? 0) + 1);
    writeFileSync(join(g, name(i)), BODY);
  }
  for (const [gen, c] of counts) {
    writeFileSync(join(home, `g${gen}`, ".writes"), String(c));
  }
}

const passSetDir = (path: string): PassSetDir => ({
  path,
  file: (...s: string[]) => join(path, ...s),
  ensure: () => {
    mkdirSync(path, { recursive: true });
    return path;
  },
});

const fmt = (c: Cost): string =>
  `${(c.user + c.sys).toFixed(3)} CPU-s (user ${c.user.toFixed(3)}, sys ${c.sys.toFixed(3)}), wall ${c.wall.toFixed(3)} s`;

const root = mkdtempSync(join(parent, "type-check-store-bench-"));
console.log(`scratch: ${root}`);
const rows: string[] = [
  "| Entries | Flat open | Flat sweep (age) | Generations open | Generations: the evicting open | Generations: rest of the unlinks (spread over later opens) |",
  "| --- | --- | --- | --- | --- | --- |",
];
try {
  for (const n of sizes) {
    const now = 3000 * DAY + PERIOD / 2;
    const flat = join(root, `flat-${n}`);
    buildFlat(flat, n, now);
    const flatOpen = measure(() => {
      flatPrune(flat, BOUNDS.maxAgeMs, 10_000_000, 9_000_000, false, now);
    });
    let flatRemoved = 0;
    const flatSweep = measure(() => {
      flatRemoved = flatPrune(
        flat,
        BOUNDS.maxAgeMs,
        10_000_000,
        9_000_000,
        true,
        now,
      );
    });
    rmSync(flat, { recursive: true, force: true });

    const gens = join(root, `gens-${n}`);
    buildGenerations(gens, n, now);
    const dir = passSetDir(gens);
    const genOpen = measure(() => {
      openPassSet(dir, BOUNDS, { now: () => now });
    });
    // The open that drops the oldest generation: renamed aside, and the
    // per-open budget of it unlinked.
    const genEvict = measure(() => {
      openPassSet(dir, BOUNDS, { now: () => now + PERIOD });
    });
    // The rest of that generation's unlinks, as the opens after it pay them
    // (here at once: the total eviction work, for comparison with the sweep).
    const genDrain = measure(() => {
      openPassSet(dir, BOUNDS, {
        now: () => now + PERIOD,
        removeBudget: Number.POSITIVE_INFINITY,
      });
    });
    const left = readdirSync(join(gens, "generations")).filter((g) =>
      /^g\d+$/.test(g),
    ).length;
    rmSync(gens, { recursive: true, force: true });

    console.log(
      `${n} entries: flat open ${fmt(flatOpen)}; flat sweep ${fmt(flatSweep)} (${flatRemoved} removed); generations open ${fmt(genOpen)}; generations evicting open ${fmt(genEvict)}; rest of the unlinks ${fmt(genDrain)} (${left} generations left)`,
    );
    rows.push(
      `| ${n.toLocaleString("en-US")} | ${fmt(flatOpen)} | ${fmt(flatSweep)} | ${fmt(genOpen)} | ${fmt(genEvict)} | ${fmt(genDrain)} |`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${rows.join("\n")}`);
