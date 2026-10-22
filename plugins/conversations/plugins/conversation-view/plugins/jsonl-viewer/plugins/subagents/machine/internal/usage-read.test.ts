import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsageSince, type UsageScan } from "./usage-read";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
async function newFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "subagents-usage-"));
  dirs.push(dir);
  return join(dir, "agent-a.jsonl");
}

const message = (id: string, output: number) =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      id,
      content: [],
      usage: { input_tokens: 1, output_tokens: output },
    },
  });

async function read(path: string, prev?: UsageScan) {
  return readUsageSince(path, (await stat(path)).size, prev);
}

describe("readUsageSince", () => {
  test("folds every complete line, then only what was appended", async () => {
    const path = await newFile();
    await writeFile(path, `${message("m1", 10)}\n${message("m2", 5)}\n`);
    const first = await read(path);
    expect(first.fold.totals.output).toBe(15);

    await appendFile(path, `${message("m3", 7)}\n`);
    const second = await read(path, first);
    expect(second.fold.totals.output).toBe(22);
    expect(second.fold.totals.input).toBe(3);
  });

  test("leaves a torn last line for the next read", async () => {
    const path = await newFile();
    const whole = message("m1", 10);
    await writeFile(path, whole.slice(0, 20));
    const torn = await read(path);
    expect(torn.offset).toBe(0);
    expect(torn.fold.totals.output).toBe(0);

    await appendFile(path, `${whole.slice(20)}\n`);
    expect((await read(path, torn)).fold.totals.output).toBe(10);
  });

  test("starts over when the file was replaced by a shorter one", async () => {
    const path = await newFile();
    await writeFile(path, `${message("m1", 10)}\n${message("m2", 5)}\n`);
    const first = await read(path);
    await writeFile(path, `${message("m9", 4)}\n`);
    expect((await read(path, first)).fold.totals.output).toBe(4);
  });
});
