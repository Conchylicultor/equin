// What a backend restart costs a corpus index's `lines` format: the first pass
// of a NEW process over a file that grew while no process held its fold state.
//
//   ./equin run plugins/infra/plugins/corpus-index/scripts/bench-restart.ts \
//     <file.jsonl> [--appends 40] [--restarts 5]
//
// The file is copied into a temp corpus minus its last `--appends` lines and
// indexed by one index instance (the process before the restart). Then, for
// each restart, a few of the held-back lines are appended and a FRESH instance
// over the same index path (a new process: nothing held in memory) runs its
// first pass. The fold JSON.parses each line, the dominant per-line cost of a
// transcript parse.
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusFormat } from "../core";
import { createCorpusIndex } from "../server/internal/corpus-index";
import { readFileRange } from "../server/internal/line-reader";

const args = process.argv.slice(2);
const source = args[0];
if (source === undefined)
  throw new Error(
    "usage: bench-restart.ts <file.jsonl> [--appends N] [--restarts N]",
  );
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const appends = Number(flag("--appends") ?? "40");
const restarts = Number(flag("--restarts") ?? "5");

interface Count {
  lines: number;
  keys: number;
}
const format = corpusFormat(import.meta, {
  match: (p: string) => p.endsWith(".jsonl"),
  lines: {
    start: () => ({ lines: 0, keys: 0 }),
    line: (s: Count, line: string) => {
      s.lines++;
      s.keys += Object.keys(JSON.parse(line) as object).length;
    },
    partial: (s: Count) => ({ ...s }),
    save: (s: Count) => ({ ...s }),
    load: (saved: Count) => ({ ...saved }),
  },
});

const text = await readFile(source, "utf8");
const all = text.split("\n").filter((l) => l !== "");
const head = all.slice(0, all.length - appends);
const tail = all.slice(all.length - appends);
console.log(
  `${source}: ${(text.length / 1e6).toFixed(1)} MB, ${all.length} lines; ${appends} lines appended over ${restarts} restarts`,
);

const dir = await mkdtemp(join(tmpdir(), "corpus-bench-restart-"));
const root = join(dir, "corpus");
const file = join(root, "p", "t.jsonl");
await mkdir(join(root, "p"), { recursive: true });
await writeFile(file, `${head.join("\n")}\n`);
const indexPath = join(dir, "index.json");

/** A new process's index over the same stored index. */
function boot() {
  return createCorpusIndex<Count>(
    {
      name: "bench",
      description: "bench",
      roots: [root],
      format,
      indexPath,
      scope: "worktree",
      watchedBy: "consumer",
    },
    {
      isMain: () => true,
      withSlot: (fn) => fn(),
      yieldMacrotask: () => new Promise<void>((r) => setImmediate(r)),
      startFileWatcher: async () => {},
      watcherRegistration: { register: () => {} },
      journal: {
        cursor: async () => ({ kind: "unsupported", reason: "bench" }),
        changesSince: async () => ({ kind: "unknown", reason: "bench" }),
      },
      digest: async () => "bench",
      readRange: readFileRange,
    },
  );
}

let t = performance.now();
let index = boot();
await index.ensureFresh();
console.log(
  `first index (cold, whole file) ${(performance.now() - t).toFixed(0)} ms`,
);

const per = Math.ceil(tail.length / restarts);
for (let i = 0; i < restarts; i++) {
  const batch = tail.slice(i * per, (i + 1) * per);
  const handle = await open(file, "r+");
  const { size } = await handle.stat();
  const bytes = `${batch.join("\n")}\n`;
  await handle.write(bytes, size);
  await handle.close();
  index = boot();
  t = performance.now();
  await index.ensureFresh();
  console.log(
    `restart ${i + 1}: first pass ${(performance.now() - t).toFixed(1)} ms (${batch.length} lines, ${(Buffer.byteLength(bytes) / 1e3).toFixed(0)} KB appended)`,
  );
}
const got = index.entries().get(file);
if (got?.lines !== all.length)
  throw new Error(`folded ${got?.lines} lines, expected ${all.length}`);
await rm(dir, { recursive: true, force: true });
