import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readTurns, readTurnsFromChain } from "./claude-transcript";

// Each case writes a temp transcript and reads it back.
const tmpFiles: string[] = [];
async function writeTranscript(lines: object[]): Promise<string> {
  const path = join(tmpdir(), `rewind-test-${crypto.randomUUID()}.jsonl`);
  tmpFiles.push(path);
  await Bun.write(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

afterEach(async () => {
  while (tmpFiles.length) {
    // `force`: a test may already have removed the file.
    await rm(tmpFiles.pop()!, { force: true });
  }
});

// ---------------------------------------------------------------------------
// readTurns / readTurnsFromChain. These need real
// uuid/parentUuid lines: the chain merge dedups on uuid and the branch filter
// walks the forest.
// ---------------------------------------------------------------------------

const T1 = "2026-06-30T01:00:00.000Z";
const T2 = "2026-06-30T02:00:00.000Z";
const T3 = "2026-06-30T03:00:00.000Z";
const FORK_T1 = "2026-06-30T09:00:00.000Z";

const uLine = (
  uuid: string,
  parentUuid: string | null,
  text: string,
  at: string,
) => ({
  type: "user",
  uuid,
  parentUuid,
  timestamp: at,
  message: { role: "user", content: text },
});
const aLine = (
  uuid: string,
  parentUuid: string | null,
  text: string,
  at: string,
) => ({
  type: "assistant",
  uuid,
  parentUuid,
  timestamp: at,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

describe("readTurnsFromChain", () => {
  test("a forked session's copied lines render once, at the ancestor's times", async () => {
    const first = await writeTranscript([
      uLine("u1", null, "hello", T1),
      aLine("u2", "u1", "hi", T2),
    ]);
    const forked = await writeTranscript([
      uLine("u1", null, "hello", FORK_T1),
      aLine("u2", "u1", "hi", FORK_T1),
      uLine("u3", "u2", "continue", T3),
    ]);

    const turns = await readTurnsFromChain([first, forked]);
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "hello"],
      ["assistant", "hi"],
      ["user", "continue"],
    ]);
    expect(turns[0]!.at).toBe(T1);
  });

  test("sinceIso filters after the merge, not before it", async () => {
    const first = await writeTranscript([
      uLine("u1", null, "hello", T1),
      aLine("u2", "u1", "hi", T2),
    ]);
    const forked = await writeTranscript([
      uLine("u1", null, "hello", FORK_T1),
      aLine("u2", "u1", "hi", FORK_T1),
      uLine("u3", "u2", "continue", T3),
    ]);

    const turns = await readTurnsFromChain([first, forked], T3);
    expect(turns.map((t) => t.text)).toEqual(["continue"]);
  });

  test("a chain entry with no transcript on disk yet is skipped", async () => {
    const first = await writeTranscript([uLine("u1", null, "hello", T1)]);
    const absent = join(tmpdir(), `absent-${crypto.randomUUID()}.jsonl`);
    expect(
      (await readTurnsFromChain([first, absent])).map((t) => t.text),
    ).toEqual(["hello"]);
  });
});

describe("readTurns", () => {
  test("returns [] for a missing file", async () => {
    expect(await readTurns(join(tmpdir(), "does-not-exist.jsonl"))).toEqual([]);
  });

  test("drops an abandoned rewind branch (behavior change: the branch filter now runs)", async () => {
    // `old` was resubmitted as `new` under the same parent, so `old` and its
    // answer are a rewound branch and no longer emitted. Before the chain work,
    // readTurns rendered them inline.
    const path = await writeTranscript([
      uLine("root", null, "hello", T1),
      aLine("a0", "root", "hi", T1),
      uLine("old", "a0", "abandoned attempt", T2),
      aLine("oldA", "old", "abandoned answer", T2),
      uLine("new", "a0", "real question", T3),
      aLine("newA", "new", "real answer", T3),
    ]);

    expect((await readTurns(path)).map((t) => t.text)).toEqual([
      "hello",
      "hi",
      "real question",
      "real answer",
    ]);
  });
});
