// Measures what the shared FSEvents stream pool (shared/fsevents-pool.ts)
// costs and saves, on macOS:
//
// 1. Streams for a real watch set: opens the watches listed in `--set
//    <file.json>` (`[{ "dir", "depth"?, "ignore"? }]`, in boot order — main's,
//    as the Background activity catalog listed them on 2026-11-09, is in the
//    research doc) and prints how many watches that is against how many
//    native streams the process holds. Before the pool every watch was its own
//    stream (parcel dedups only the same dir with the same ignore).
// 2. Delivery lag (the `watch-delivery` metric: a write → the batch's arrival)
//    of a children watch on a stream of its own, against one riding a covering
//    recursive stream, written to side by side once a second.
//
//   ./equin run plugins/infra/plugins/file-watcher/scripts/measure-stream-pool.ts \
//     [--set watches.json] [--rounds 30]
//
// Research: research/2026-11-09-infra-file-watcher-stream-pool.md
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpath, stat } from "@plugins/packages/plugins/timed-fs/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWatcher,
  fsEventsStreams,
  type FileWatcher,
} from "../shared/engine";

const argv = process.argv.slice(2);
const at = argv.indexOf("--rounds");
const rounds = at >= 0 ? Number(argv[at + 1]) : 30;

const setAt = argv.indexOf("--set");
const setFile = setAt >= 0 ? argv[setAt + 1] : undefined;

interface WatchSpec {
  dir: string;
  depth?: "subtree" | "children";
  ignore?: string[];
}

async function exists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function streamsForSet(file: string): Promise<void> {
  const set = JSON.parse(await Bun.file(file).text()) as WatchSpec[];
  const held: FileWatcher[] = [];
  const instances = new Set<string>();
  let watches = 0;
  let unpooled = 0;
  for (const { dir, depth = "subtree", ignore } of set) {
    if (!(await exists(dir))) continue;
    watches += 1;
    instances.add(`${depth}\0${dir}\0${ignore?.join(",") ?? ""}`);
    if (ignore !== undefined) unpooled += 1;
    held.push(
      await createFileWatcher({
        dirs: [dir],
        depth,
        ...(ignore ? { ignore } : {}),
        onChange: () => {},
      }),
    );
  }
  const pooled = fsEventsStreams().open;
  console.log(`watch set: ${watches} watches`);
  console.log(
    `  before (one stream per distinct dir+depth+ignore): ${instances.size} streams`,
  );
  console.log(
    `  after: ${pooled.length + unpooled} streams (${pooled.length} pooled + ${unpooled} with an ignore)`,
  );
  for (const s of pooled)
    console.log(`    ${s.depth.padEnd(8)} ${s.riders} × ${s.root}`);
  await Promise.all(held.map((w) => w.stop()));
}

function summary(name: string, xs: number[]): string {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number =>
    s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
  return `${name}: n=${s.length} p50=${q(0.5).toFixed(0)}ms p90=${q(0.9).toFixed(0)}ms max=${(s.at(-1) ?? NaN).toFixed(0)}ms`;
}

async function deliveryLag(): Promise<void> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fw-pool-measure-")),
  );
  const ownDir = join(root, "own");
  const covered = join(root, "covered");
  const ridingDir = join(covered, "a");
  await mkdir(ownDir);
  await mkdir(ridingDir, { recursive: true });
  const lag = { own: [] as number[], riding: [] as number[] };
  const probe = { own: [] as number[], riding: [] as number[] };
  const written = new Map<string, number>();
  const watch = (dir: string, key: "own" | "riding") =>
    createFileWatcher({
      dirs: [dir],
      depth: "children",
      debounceMs: 0,
      onDeliveryLag: (s) => void probe[key].push(s.lagMs),
      onChange: (events) => {
        const now = Date.now();
        for (const e of events) {
          const t = written.get(e.path);
          if (t !== undefined) {
            lag[key].push(now - t);
            written.delete(e.path);
          }
        }
      },
    });
  const cover = await createFileWatcher({
    dirs: [covered],
    onChange: () => {},
  });
  const own = await watch(ownDir, "own");
  const riding = await watch(ridingDir, "riding");
  console.log(
    `streams under the probe dir: ${fsEventsStreams()
      .open.filter((s) => s.root.startsWith(root))
      .map((s) => `${s.depth}×${s.riders}`)
      .join(", ")}`,
  );
  for (let i = 0; i < rounds; i++) {
    for (const dir of [ownDir, ridingDir]) {
      const file = join(dir, `f${i}`);
      written.set(file, Date.now());
      await writeFile(file, "x");
    }
    await Bun.sleep(1000);
  }
  // Let the last writes arrive (fseventsd's queue: seconds while it is loaded).
  for (let i = 0; i < 300 && written.size > 0; i++) await Bun.sleep(100);
  console.log(summary("children watch, own stream ", lag.own));
  console.log(summary("children watch, riding cover", lag.riding));
  console.log(summary("  watch-delivery probe, own   ", probe.own));
  console.log(summary("  watch-delivery probe, riding", probe.riding));
  console.log(`unheard writes: ${written.size}`);
  await Promise.all([own.stop(), riding.stop(), cover.stop()]);
  await rm(root, { recursive: true, force: true });
}

if (setFile !== undefined) await streamsForSet(setFile);
await deliveryLag();
console.log(`streams opened by this process: ${fsEventsStreams().opened}`);
