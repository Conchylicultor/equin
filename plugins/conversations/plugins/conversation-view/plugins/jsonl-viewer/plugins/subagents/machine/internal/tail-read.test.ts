import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTail, TAIL_WINDOW_BYTES } from "./tail-read";

const dirs: string[] = [];
async function newDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "subagents-tail-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

const assistant = (content: unknown[]) =>
  line({
    type: "assistant",
    uuid: crypto.randomUUID(),
    isSidechain: true,
    message: { role: "assistant", content },
  });

/** `readTail` over a freshly written file, at its real size. */
async function tailOf(path: string) {
  const { size } = await stat(path);
  return readTail(path, size);
}
const lastStepOf = async (path: string) => (await tailOf(path)).lastStep;

describe("readTail", () => {
  test("a tool_use block becomes the tool step, previewed by its most identifying argument", async () => {
    const path = join(await newDir(), "agent-a.jsonl");
    await writeFile(
      path,
      assistant([
        { type: "text", text: "Let me look." },
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/repo/plugins/parse-jsonl.ts" },
        },
      ]),
    );
    expect(await lastStepOf(path)).toEqual({
      kind: "tool",
      toolName: "Read",
      // A path shows as its last segment; a command shows whole.
      preview: "parse-jsonl.ts",
    });
  });

  test("it walks back past the bookkeeping lines the harness appends after the assistant's", async () => {
    const path = join(await newDir(), "agent-a.jsonl");
    await writeFile(
      path,
      assistant([
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "rg -n isSidechain" },
        },
      ]),
    );
    // An `attachment` line says nothing about what the sub-agent is doing, and it
    // is routinely the last line in a real transcript.
    await appendFile(
      path,
      line({ type: "attachment", uuid: crypto.randomUUID(), attachment: {} }),
    );
    expect(await lastStepOf(path)).toEqual({
      kind: "tool",
      toolName: "Bash",
      preview: "rg -n isSidechain",
    });
  });

  test("a file far larger than the window still reports its LAST step", async () => {
    const path = join(await newDir(), "agent-big.jsonl");
    // Three windows' worth of noise, then the step we must find.
    const filler = assistant([{ type: "text", text: "x".repeat(4_000) }]);
    let bulk = "";
    while (bulk.length < TAIL_WINDOW_BYTES * 3) bulk += filler;
    await writeFile(path, bulk);
    await appendFile(
      path,
      assistant([
        { type: "tool_use", name: "Grep", input: { pattern: "isSidechain" } },
      ]),
    );

    const { size } = await stat(path);
    expect(size).toBeGreaterThan(TAIL_WINDOW_BYTES);
    expect(await lastStepOf(path)).toEqual({
      kind: "tool",
      toolName: "Grep",
      preview: "isSidechain",
    });
  });

  test("the half line the window cuts through is never parsed as a line of its own", async () => {
    const path = join(await newDir(), "agent-cut.jsonl");
    // One enormous line, so the window necessarily starts in the middle of it,
    // followed by one small complete line. Reading the fragment would throw or
    // silently mis-classify; the answer must come from the complete line.
    await writeFile(
      path,
      assistant([{ type: "text", text: "y".repeat(TAIL_WINDOW_BYTES * 2) }]),
    );
    await appendFile(
      path,
      assistant([{ type: "thinking", thinking: "Weighing the options" }]),
    );
    expect(await lastStepOf(path)).toEqual({
      kind: "thinking",
      preview: "Weighing the options",
    });
  });

  test("an empty transcript has no step — which is not the same as having done nothing", async () => {
    const path = join(await newDir(), "agent-empty.jsonl");
    await writeFile(path, "");
    expect(await lastStepOf(path)).toBeNull();
  });

  test("the same read says whether the newest turn has ended, and when its newest line was written", async () => {
    const path = join(await newDir(), "agent-done.jsonl");
    await writeFile(path, assistant([{ type: "text", text: "Working" }]));
    expect((await tailOf(path)).turnEnded).toBe(false);
    await appendFile(
      path,
      line({
        type: "assistant",
        uuid: crypto.randomUUID(),
        timestamp: "2026-10-07T02:34:00.164Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done." }],
        },
      }),
    );
    // The harness appends bookkeeping after the closing piece.
    await appendFile(path, line({ type: "attachment", attachment: {} }));
    expect(await tailOf(path)).toEqual({
      lastStep: { kind: "text", preview: "Done." },
      turnEnded: true,
      newestTurnLineAt: "2026-10-07T02:34:00.164Z",
    });
  });
});
