import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFile,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineFold } from "../../core";
import { createCheckpointStore, type CheckpointStore } from "./checkpoints";
import { createLineReader, readFileRange, type FileStamp } from "./line-reader";

// The fold under test records every line it saw, so "read only what was
// appended" and "fold again from the start" are directly observable.
interface Seen {
  lines: string[];
  starts: number;
}
let starts = 0;
const fold: LineFold<unknown, string[]> = {
  start: () => {
    starts++;
    return { lines: [], starts } satisfies Seen;
  },
  line: (s, line) => (s as Seen).lines.push(line),
  partial: (s) => [...(s as Seen).lines],
  save: (s) => structuredClone(s),
  load: (saved) => structuredClone(saved),
};

// No checkpoints: every reader but the checkpoint tests' starts over.
const noCheckpoints: CheckpointStore = {
  load: async () => ({ kind: "none" }),
  writer: null,
};

let dir: string;
let file: string;
let bytesRead: number;

function reader(maxHeld = 8, checkpoints = noCheckpoints) {
  return createLineReader(fold, {
    maxHeld,
    checkpoints,
    yieldMacrotask: () => new Promise<void>((r) => setImmediate(r)),
    readRange: async (p, start, end) => {
      const bytes = await readFileRange(p, start, end);
      bytesRead += bytes.length;
      return bytes;
    },
  });
}

async function stamp(path = file): Promise<FileStamp> {
  const st = await stat(path);
  return { size: st.size, ino: st.ino };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "line-reader-test-"));
  file = join(dir, "t.jsonl");
  starts = 0;
  bytesRead = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("an append is read from where the last read stopped, not from the start", async () => {
  const r = reader();
  await writeFile(file, "a\nb\n");
  expect(await r.read(file, await stamp())).toEqual(["a", "b"]);
  bytesRead = 0;
  await appendFile(file, "c\n");
  expect(await r.read(file, await stamp())).toEqual(["a", "b", "c"]);
  expect(starts).toBe(1);
  // The 2 appended bytes plus the held tail ("a\nb\n") checked before them.
  expect(bytesRead).toBe(2 + 4);
});

test("a line still being written is folded once its newline lands", async () => {
  const r = reader();
  await writeFile(file, "a\npart");
  expect(await r.read(file, await stamp())).toEqual(["a"]);
  await appendFile(file, "ial\n");
  expect(await r.read(file, await stamp())).toEqual(["a", "partial"]);
  expect(starts).toBe(1);
});

test("a read never goes past the size the pass stat'd", async () => {
  const r = reader();
  await writeFile(file, "a\n");
  const before = await stamp();
  await appendFile(file, "b\n");
  expect(await r.read(file, before)).toEqual(["a"]);
  expect(await r.read(file, await stamp())).toEqual(["a", "b"]);
});

test("a truncated, rewritten or replaced file is folded again from its start", async () => {
  const r = reader();
  await writeFile(file, "a\nb\n");
  await r.read(file, await stamp());

  // Truncated (shorter than what was folded).
  await truncate(file, 2);
  expect(await r.read(file, await stamp())).toEqual(["a"]);
  expect(starts).toBe(2);

  // Rewritten in place, longer: the bytes before the held offset moved.
  await writeFile(file, "x\ny\nz\n");
  expect(await r.read(file, await stamp())).toEqual(["x", "y", "z"]);
  expect(starts).toBe(3);

  // Replaced by rename with the same prefix: another inode.
  const other = join(dir, "other.jsonl");
  await writeFile(other, "x\ny\nz\nw\n");
  await rename(other, file);
  expect(await r.read(file, await stamp())).toEqual(["x", "y", "z", "w"]);
  expect(starts).toBe(4);
});

test("lines longer than a read chunk and many appends fold exactly like one whole read", async () => {
  const long = "x".repeat(5 * 1024 * 1024); // past the 4 MB chunk
  const lines = ["one", long, "two", "é—multibyte✓", "", "three"];
  const r = reader();
  let written = "";
  for (const [i, line] of lines.entries()) {
    // Split each line's write in two, so reads land mid-line.
    const text = `${line}\n`;
    const cut = Math.floor(text.length / 2);
    await appendFile(file, text.slice(0, cut));
    await r.read(file, await stamp());
    await appendFile(file, text.slice(cut));
    written += text;
    const got = await r.read(file, await stamp());
    expect(got).toEqual(lines.slice(0, i + 1).filter((l) => l !== ""));
  }
  expect(starts).toBe(1);
  const whole = reader();
  expect(await whole.read(file, await stamp())).toEqual(
    written.split("\n").filter((l) => l !== ""),
  );
});

test("the held states are bounded: the least recently read is evicted and folded again", async () => {
  const r = reader(2);
  const files = ["a", "b", "c"].map((n) => join(dir, `${n}.jsonl`));
  for (const f of files) {
    await writeFile(f, "1\n");
    await r.read(f, await stamp(f));
  }
  expect(r.held()).toBe(2);
  expect(starts).toBe(3);
  // "a" was evicted: its next read starts over; "c" continues.
  await appendFile(files[2]!, "2\n");
  await r.read(files[2]!, await stamp(files[2]));
  expect(starts).toBe(3);
  await appendFile(files[0]!, "2\n");
  expect(await r.read(files[0]!, await stamp(files[0]))).toEqual(["1", "2"]);
  expect(starts).toBe(4);
});

test("a read that throws leaves no half-folded state behind", async () => {
  let boom = false;
  const r = createLineReader<string[]>(
    {
      ...fold,
      line: (s, line) => {
        if (boom && line === "bad") throw new Error("boom");
        fold.line(s, line);
      },
    },
    {
      maxHeld: 8,
      yieldMacrotask: async () => {},
      readRange: readFileRange,
      checkpoints: noCheckpoints,
    },
  );
  await writeFile(file, "a\n");
  await r.read(file, await stamp());
  await appendFile(file, "b\nbad\n");
  boom = true;
  expect(r.read(file, await stamp())).rejects.toThrow("boom");
  await new Promise((res) => setImmediate(res));
  expect(r.held()).toBe(0);
  boom = false;
  expect(await r.read(file, await stamp())).toEqual(["a", "b", "bad"]);
});

// ─── checkpoints: a new process continues where the last one stopped ─────────

/** Past the 1 MiB a reader folds before its first checkpoint. */
const BIG = `${"x".repeat(1024 * 1024)}\n`;

const store = (persist = true, version = "v1") =>
  createCheckpointStore(join(dir, "index.json"), version, persist);

test("a new reader continues a file from the checkpoint the last one wrote", async () => {
  await writeFile(file, `a\n${BIG}b\n`);
  await reader(8, store()).read(file, await stamp());
  expect(starts).toBe(1);

  await appendFile(file, "c\n");
  bytesRead = 0;
  // A new process: nothing held in memory.
  const got = await reader(8, store()).read(file, await stamp());
  expect(got).toEqual(["a", BIG.slice(0, -1), "b", "c"]);
  expect(starts).toBe(1);
  // The 2 appended bytes plus the checkpoint's tail checked before them.
  expect(bytesRead).toBe(2 + 64);
});

test("a checkpoint that no longer describes the file is not continued", async () => {
  await writeFile(file, `a\n${BIG}`);
  await reader(8, store()).read(file, await stamp());
  // Rewritten in place, longer: the bytes before the checkpoint moved.
  await writeFile(file, `z\n${"y".repeat(BIG.length - 1)}\nw\n`);
  const got = await reader(8, store()).read(file, await stamp());
  expect(got[0]).toBe("z");
  expect(got).toHaveLength(3);
  expect(starts).toBe(2);
});

test("a file folded less than the checkpoint window is folded again by a new reader", async () => {
  await writeFile(file, "a\nb\n");
  await reader(8, store()).read(file, await stamp());
  await reader(8, store()).read(file, await stamp());
  expect(starts).toBe(2);
});

test("a backend that does not persist reads checkpoints but never writes one", async () => {
  await writeFile(file, `a\n${BIG}`);
  await reader(8, store(false)).read(file, await stamp());
  expect(await readdir(dir)).toEqual(["t.jsonl"]);
  // …yet continues from the persisting backend's.
  await reader(8, store(true)).read(file, await stamp());
  await appendFile(file, "c\n");
  await reader(8, store(false)).read(file, await stamp());
  expect(starts).toBe(2);
});

test("a forgotten file's checkpoint is gone", async () => {
  await writeFile(file, `a\n${BIG}`);
  await reader(8, store()).read(file, await stamp());
  await reader(8, store()).forget(file);
  await reader(8, store()).read(file, await stamp());
  expect(starts).toBe(2);
});

test("another format digest's checkpoints are never loaded, and are removed by the first write", async () => {
  await writeFile(file, `a\n${BIG}`);
  await reader(8, store(true, "v1")).read(file, await stamp());
  await reader(8, store(true, "v2")).read(file, await stamp());
  expect(starts).toBe(2);
  expect(await readdir(join(dir, "index.json.lines"))).toHaveLength(1);
});
