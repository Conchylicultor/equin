import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppends, type SeedBack } from "./appends";

// An append follow reads no history: a file met for the first time starts at
// its end, handing over only the trailing lines its backward read takes; every
// later read hands over exactly the complete lines appended since.

const tmpFiles: string[] = [];
afterAll(async () => {
  for (const f of tmpFiles) await rm(f, { force: true });
});

function tmpPath(): string {
  const path = join(tmpdir(), `appends-test-${crypto.randomUUID()}.jsonl`);
  tmpFiles.push(path);
  return path;
}

const jsonl = (...ids: string[]) =>
  ids.map((id) => `${JSON.stringify({ id })}\n`).join("");

/** Takes lines back to (and including) the one with id `to`. */
const backTo =
  (to: string): SeedBack =>
  () => {
    let done = false;
    return (line) => {
      if (done) return "stop";
      if (line.id === to) done = true;
      return "take";
    };
  };

const ids = (read: Awaited<ReturnType<typeof readAppends>>) =>
  read.delivery.lines.map(
    (l) => `${l.seed ? "seed:" : ""}${String(l.line.id)}`,
  );

describe("readAppends", () => {
  test("starts at the end, then hands over only what is appended", async () => {
    const path = tmpPath();
    await writeFile(path, jsonl("a", "b", "c", "d") + '{"id":"unfinish');
    const first = await readAppends([path], undefined, backTo("c"));
    expect(ids(first)).toEqual(["seed:c", "seed:d"]);

    await appendFile(path, 'ed"}\n' + jsonl("e"));
    const second = await readAppends([path], first, backTo("c"));
    expect(ids(second)).toEqual(["unfinished", "e"]);

    const third = await readAppends([path], second, backTo("c"));
    expect(ids(third)).toEqual([]);
  });

  test("a backward read crosses chunk boundaries whole", async () => {
    const path = tmpPath();
    const big = "x".repeat(150 * 1024);
    const lines = ["a", "b", "c"].map(
      (id) => JSON.stringify({ id, big }) + "\n",
    );
    await writeFile(path, lines.join(""));
    const read = await readAppends([path], undefined, backTo("a"));
    expect(ids(read)).toEqual(["seed:a", "seed:b", "seed:c"]);
    expect(read.delivery.lines.every((l) => l.line.big === big)).toBe(true);
  });

  test("a file cut short, or one new to the chain, starts over at its end", async () => {
    const first = tmpPath();
    await writeFile(first, jsonl("a", "b", "c"));
    const start = await readAppends([first], undefined, backTo("c"));
    expect(ids(start)).toEqual(["seed:c"]);

    await truncate(first, jsonl("a").length);
    await appendFile(first, jsonl("r"));
    const second = tmpPath();
    await writeFile(second, jsonl("s1", "s2"));
    const after = await readAppends([first, second], start, backTo("s2"));
    // The cut file reads back to its start (no "s2" in it); the new one only its last line.
    expect(ids(after)).toEqual(["seed:a", "seed:r", "seed:s2"]);

    await appendFile(second, jsonl("s3"));
    expect(ids(await readAppends([first, second], after, backTo("x")))).toEqual(
      ["s3"],
    );
  });
});
