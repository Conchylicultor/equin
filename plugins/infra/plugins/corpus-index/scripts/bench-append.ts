// What one append to a large file costs a corpus index's pass — read whole
// (`parse`) against read from where it stopped (`lines`).
//
//   ./equin run plugins/infra/plugins/corpus-index/scripts/bench-append.ts \
//     <file.jsonl> [--appends 40] [--seed-index <index.json>]
//
// The file is copied into a temp corpus minus its last `--appends` lines, which
// are then appended one at a time, each followed by the pass a watcher batch
// runs (`markChanged` + `ensureFresh`). `--seed-index` loads a real stored
// index's entries (as entries of another root, never walked) so the persist
// cost is measured against a real-sized document. Both readings fold each line
// with JSON.parse, the dominant per-line cost of a transcript parse.
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusFormat, type CorpusFormat } from "../core";
import { createCorpusIndex } from "../server/internal/corpus-index";
import { readFileRange } from "../server/internal/line-reader";

const args = process.argv.slice(2);
const source = args[0];
if (source === undefined)
  throw new Error(
    "usage: bench-append.ts <file.jsonl> [--appends N] [--seed-index index.json]",
  );
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const appends = Number(flag("--appends") ?? "40");
const seedIndex = flag("--seed-index");

interface Count {
  lines: number;
  keys: number;
}
const foldLine = (s: Count, line: string): void => {
  s.lines++;
  s.keys += Object.keys(JSON.parse(line) as object).length;
};

const formats: Record<string, CorpusFormat<Count>> = {
  parse: corpusFormat(import.meta, {
    match: (p: string) => p.endsWith(".jsonl"),
    parse: async (p: string): Promise<Count> => {
      const s = { lines: 0, keys: 0 };
      for (const l of (await readFile(p, "utf8")).split("\n"))
        if (l) foldLine(s, l);
      return s;
    },
  }),
  lines: corpusFormat(import.meta, {
    match: (p: string) => p.endsWith(".jsonl"),
    lines: {
      start: () => ({ lines: 0, keys: 0 }),
      line: foldLine,
      partial: (s: Count) => ({ ...s }),
      save: (s: Count) => ({ ...s }),
      load: (saved: Count) => ({ ...saved }),
    },
  }),
};

const text = await readFile(source, "utf8");
const all = text.split("\n").filter((l) => l !== "");
const head = all.slice(0, all.length - appends);
const tail = all.slice(all.length - appends);
console.log(
  `${source}: ${(text.length / 1e6).toFixed(1)} MB, ${all.length} lines; ${appends} appends`,
);

for (const [mode, format] of Object.entries(formats)) {
  const dir = await mkdtemp(join(tmpdir(), "corpus-bench-"));
  const root = join(dir, "corpus");
  const file = join(root, "p", "t.jsonl");
  await mkdir(join(root, "p"), { recursive: true });
  await writeFile(file, `${head.join("\n")}\n`);
  const indexPath = join(dir, "index.json");
  if (seedIndex !== undefined) {
    const seeded = JSON.parse(await readFile(seedIndex, "utf8")) as {
      files: object;
    };
    await writeFile(
      indexPath,
      JSON.stringify({ version: "bench", files: seeded.files }),
    );
  }
  const index = createCorpusIndex<Count>(
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
      startFileWatcher: async () => ({
        drained: async () => {},
        losses: () => 0,
      }),
      watcherRegistration: { register: () => {} },
      journal: {
        cursor: async () => ({ kind: "unsupported", reason: "bench" }),
        changesSince: async () => ({ kind: "unknown", reason: "bench" }),
      },
      digest: async () => "bench",
      readRange: readFileRange,
    },
  );
  let t = performance.now();
  await index.ensureFresh();
  const cold = performance.now() - t;
  const ms: number[] = [];
  for (const line of tail) {
    // An agent's append, written at the file's end (the corpus file is the
    // bench's own temp copy).
    const handle = await open(file, "r+");
    const { size } = await handle.stat();
    await handle.write(`${line}\n`, size);
    await handle.close();
    index.markChanged([file]);
    t = performance.now();
    await index.ensureFresh();
    ms.push(performance.now() - t);
  }
  const got = index.entries().get(file);
  if (got?.lines !== all.length)
    throw new Error(
      `${mode}: folded ${got?.lines} lines, expected ${all.length}`,
    );
  if (process.env.BENCH_SAMPLES)
    console.log(ms.map((m) => m.toFixed(1)).join(" "));
  ms.sort((a, b) => a - b);
  const pct = (p: number) =>
    ms[Math.min(ms.length - 1, Math.floor(ms.length * p))]!.toFixed(2);
  const total = ms.reduce((a, b) => a + b, 0);
  console.log(
    `${mode.padEnd(5)} cold ${cold.toFixed(0)} ms | per append p50 ${pct(0.5)} ms, p90 ${pct(0.9)} ms, max ${pct(1)} ms, total ${total.toFixed(0)} ms`,
  );
  await rm(dir, { recursive: true, force: true });
}
