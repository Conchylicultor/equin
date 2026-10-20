import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  readChain,
  readJsonlEventsFromChain,
  type ChainRead,
} from "./parse-jsonl";

// An incremental read (`readChain(paths, previous)`) must answer exactly what a
// full read of the same files answers — whatever byte boundaries the appends
// land on, and through a rewind, a replaced file and a growing chain. The
// events are always built from every held line, so these pin the line
// bookkeeping: offsets, partial lines, dedup and when to start over.

const tmpFiles: string[] = [];
afterAll(async () => {
  for (const f of tmpFiles) await rm(f, { force: true });
});

function tmpPath(): string {
  const path = join(tmpdir(), `read-chain-test-${crypto.randomUUID()}.jsonl`);
  tmpFiles.push(path);
  return path;
}

const at = (n: number) =>
  new Date(Date.UTC(2026, 9, 20, 0, 0, n)).toISOString();

const user = (
  uuid: string,
  parent: string | null,
  text: string,
  n: number,
) => ({
  type: "user",
  uuid,
  parentUuid: parent,
  timestamp: at(n),
  message: { role: "user", content: text },
});
const assistantText = (
  uuid: string,
  parent: string,
  msgId: string,
  text: string,
  n: number,
) => ({
  type: "assistant",
  uuid,
  parentUuid: parent,
  timestamp: at(n),
  message: {
    role: "assistant",
    id: msgId,
    content: [{ type: "text", text }],
  },
});
const toolUse = (uuid: string, parent: string, id: string, n: number) => ({
  type: "assistant",
  uuid,
  parentUuid: parent,
  timestamp: at(n),
  message: {
    role: "assistant",
    id: `m-${id}`,
    content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
  },
});
const toolResult = (uuid: string, parent: string, id: string, n: number) => ({
  type: "user",
  uuid,
  parentUuid: parent,
  timestamp: at(n),
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: [
          { type: "text", text: "a.txt" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
    ],
  },
  toolUseResult: { stdout: "a.txt".repeat(100) },
});
const pastedImage = (uuid: string, parent: string, n: number) => ({
  type: "user",
  uuid,
  parentUuid: parent,
  timestamp: at(n),
  message: {
    role: "user",
    content: [
      { type: "text", text: "look" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgo=",
        },
      },
    ],
  },
});
const metadata = () => ({ type: "permission-mode", permissionMode: "default" });

/** A conversation whose events depend on lines across the whole file. */
const LINES: Record<string, unknown>[] = [
  user("u1", null, "first prompt", 1),
  metadata(),
  assistantText("a1", "u1", "msg-1", "part one, ", 2),
  // The same message continued on a later line: merged into one event.
  assistantText("a2", "a1", "msg-1", "part two", 3),
  toolUse("t1", "a2", "call-1", 4),
  // The result lands later and is attached to the call.
  toolResult("r1", "t1", "call-1", 5),
  pastedImage("p1", "r1", 6),
  user("u2", "p1", "second prompt — with ünïcödé", 7),
  assistantText("a3", "u2", "msg-2", "done", 8),
];

const jsonl = (lines: Record<string, unknown>[]) =>
  lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

async function fullRead(paths: string[]): Promise<JsonlEvent[]> {
  return readJsonlEventsFromChain(paths);
}

/** Write `text` to `path` in the given chunk sizes (bytes), reading after each. */
async function appendInChunks(
  path: string,
  bytes: Uint8Array,
  sizes: number[],
  previous: ChainRead | undefined,
): Promise<ChainRead | undefined> {
  let read = previous;
  let offset = 0;
  let i = 0;
  while (offset < bytes.length) {
    const size = sizes[i++ % sizes.length]!;
    await appendFile(path, bytes.subarray(offset, offset + size));
    offset += size;
    read = await readChain([path], read);
  }
  return read;
}

describe("readChain — incremental equals full", () => {
  for (const sizes of [[1], [7], [13, 1, 64], [100000]]) {
    test(`appends in chunks of ${sizes.join(",")} bytes`, async () => {
      const path = tmpPath();
      await Bun.write(path, "");
      const bytes = new TextEncoder().encode(jsonl(LINES));
      const read = await appendInChunks(path, bytes, sizes, undefined);
      expect(await read!.lines.events()).toEqual(await fullRead([path]));
    });
  }

  test("a line read in two halves is held once, from where it starts", async () => {
    const path = tmpPath();
    const text = jsonl(LINES.slice(0, 1));
    await Bun.write(path, text.slice(0, 10));
    const first = await readChain([path]);
    expect(first.lines.lines()).toHaveLength(0);
    expect(first.lines.consumed(path)).toBe(0);
    await appendFile(path, text.slice(10));
    const second = await readChain([path], first);
    expect(second).toBe(first);
    expect(second.lines.lines()).toHaveLength(1);
  });

  test("a rewind sibling appended later drops the abandoned branch, as a full read does", async () => {
    const path = tmpPath();
    await Bun.write(path, jsonl(LINES));
    const before = await readChain([path]);
    // A new prompt under u1's parent's child p1: a sibling of u2 — u2 and what
    // followed it are now a rewound branch.
    await appendFile(
      path,
      jsonl([user("u3", "p1", "edited second prompt", 9)]),
    );
    const after = await readChain([path], before);
    expect(after).toBe(before);
    const events = await after.lines.events();
    expect(events).toEqual(await fullRead([path]));
    expect(
      events
        .filter((e) => e.kind === "user-text")
        .map((e) => e.kind === "user-text" && e.text),
    ).toEqual(["first prompt", "look", "edited second prompt"]);
  });

  test("a replaced file (a rewind writes a new one) is read from scratch", async () => {
    const path = tmpPath();
    await Bun.write(path, jsonl(LINES));
    const before = await readChain([path]);
    const replacement = tmpPath();
    await Bun.write(replacement, jsonl(LINES.slice(0, 3)));
    await rename(replacement, path);
    const after = await readChain([path], before);
    expect(after).not.toBe(before);
    expect(await after.lines.events()).toEqual(await fullRead([path]));
  });

  test("a shrunk file is read from scratch", async () => {
    const path = tmpPath();
    await Bun.write(path, jsonl(LINES));
    const before = await readChain([path]);
    const handle = await import("node:fs/promises").then((fs) =>
      fs.open(path, "r+"),
    );
    await handle.truncate(jsonl(LINES.slice(0, 2)).length);
    await handle.close();
    const after = await readChain([path], before);
    expect(after).not.toBe(before);
    expect(await after.lines.events()).toEqual(await fullRead([path]));
  });

  test("a new session file at the chain's end is continued; a fork's copied lines are held once", async () => {
    const a = tmpPath();
    await Bun.write(a, jsonl(LINES.slice(0, 5)));
    const before = await readChain([a]);
    const b = tmpPath();
    // A fork copies its ancestor's lines verbatim, then continues.
    await Bun.write(b, jsonl([...LINES.slice(0, 5), ...LINES.slice(5)]));
    const after = await readChain([a, b], before);
    expect(after).toBe(before);
    expect(await after.lines.events()).toEqual(await fullRead([a, b]));
  });

  test("an earlier chain file that grows makes the chain read from scratch", async () => {
    const a = tmpPath();
    const b = tmpPath();
    await Bun.write(a, jsonl(LINES.slice(0, 3)));
    await Bun.write(b, jsonl(LINES.slice(5, 7)));
    const before = await readChain([a, b]);
    await appendFile(a, jsonl(LINES.slice(3, 5)));
    const after = await readChain([a, b], before);
    expect(after).not.toBe(before);
    expect(await after.lines.events()).toEqual(await fullRead([a, b]));
  });
});

describe("readChain — held slim", () => {
  test("inline images become keys; tool-result images, toolUseResult and timestamp-less metadata are dropped", async () => {
    const path = tmpPath();
    await Bun.write(path, jsonl(LINES));
    const read = await readChain([path]);
    const held = JSON.stringify(read.lines.lines());
    expect(held).not.toContain("iVBORw0KGgo=");
    expect(held).not.toContain("AAAA");
    expect(held).not.toContain("toolUseResult");
    expect(held).not.toContain("permission-mode");
    const image = (await read.lines.events()).find(
      (e) => e.kind === "user-image",
    );
    expect(image?.kind === "user-image" && image.image.mime).toBe("image/png");
  });
});
