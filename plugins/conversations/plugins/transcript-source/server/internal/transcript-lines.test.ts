import { describe, expect, test } from "bun:test";
import { mergeChainLines } from "./transcript-lines";

// A conversation's session chain merged into one line array — the one-off read
// of whole files through `TranscriptLines`.

const T1 = "2026-06-30T01:00:00.000Z";
const T2 = "2026-06-30T02:00:00.000Z";
const T3 = "2026-06-30T03:00:00.000Z";
const T4 = "2026-06-30T04:00:00.000Z";

// A forked session rewrites the copied lines' timestamps; keep them distinct so
// "first wins" is observable rather than coincidental.
const FORK_T1 = "2026-06-30T09:00:00.000Z";
const FORK_T2 = "2026-06-30T09:30:00.000Z";

const userLine = (
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

const assistantLine = (
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

const chainFile = (path: string, lines: Record<string, unknown>[]) => ({
  path,
  raw: lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
});

const uuidsOf = (lines: readonly Record<string, unknown>[]) =>
  lines.map((l) => l.uuid);
const stampsOf = (lines: readonly Record<string, unknown>[]) =>
  lines.map((l) => l.timestamp);

describe("mergeChainLines", () => {
  test("superset fork — shared uuids appear once, with the ancestor's timestamps", () => {
    // B is what Claude writes when it forks A: every one of A's lines is copied
    // verbatim (same uuid, restamped), then B continues past the copy.
    const a = chainFile("a.jsonl", [
      userLine("u1", null, "hello", T1),
      assistantLine("u2", "u1", "hi", T2),
    ]);
    const b = chainFile("b.jsonl", [
      userLine("u1", null, "hello", FORK_T1),
      assistantLine("u2", "u1", "hi", FORK_T2),
      userLine("u3", "u2", "continue", T3),
    ]);

    const merged = mergeChainLines([a, b]);
    expect(uuidsOf(merged)).toEqual(["u1", "u2", "u3"]);
    expect(stampsOf(merged)).toEqual([T1, T2, T3]);
  });

  test("disjoint fresh session — nothing is deduped, chain order is preserved", () => {
    const a = chainFile("a.jsonl", [userLine("u1", null, "hello", T1)]);
    const c = chainFile("c.jsonl", [
      userLine("c1", null, "fresh start", T3),
      assistantLine("c2", "c1", "ok", T4),
    ]);

    expect(uuidsOf(mergeChainLines([a, c]))).toEqual(["u1", "c1", "c2"]);
  });

  test("midpoint fork — the ancestor's post-fork lines survive the merge itself", () => {
    // The merge is uuid-dedup only; dropping `a2` is the branch filter's doing,
    // which runs one level up. Asserted end-to-end below.
    const a = chainFile("a.jsonl", [
      userLine("u1", null, "hello", T1),
      assistantLine("u2", "u1", "hi", T2),
      userLine("a2", "u2", "ancestor kept talking", T3),
    ]);
    const b = chainFile("b.jsonl", [
      userLine("u1", null, "hello", FORK_T1),
      assistantLine("u2", "u1", "hi", FORK_T2),
      userLine("b1", "u2", "fork kept talking", T4),
    ]);

    expect(uuidsOf(mergeChainLines([a, b]))).toEqual(["u1", "u2", "a2", "b1"]);
  });

  test("uuid-less lines: a timestamped one survives from every file, one without a timestamp is dropped", () => {
    // Dedup is keyed on uuid; a line without one is kept per file. One with no
    // timestamp either (ai-title, permission-mode, api-request-blob, …) is read
    // by no event and not in the forest, so it is not held at all.
    const a = chainFile("a.jsonl", [
      { type: "ai-title", title: "shared" },
      { type: "system", content: "note", timestamp: T1 },
      userLine("u1", null, "hello", T1),
    ]);
    const b = chainFile("b.jsonl", [
      { type: "ai-title", title: "shared" },
      { type: "system", content: "note", timestamp: T1 },
      userLine("u1", null, "hello", FORK_T1),
      { type: "permission-mode", mode: "default" },
    ]);

    const merged = mergeChainLines([a, b]);
    expect(merged.map((l) => l.type)).toEqual(["system", "user", "system"]);
  });

  test("a malformed line is skipped; the rest of the file still parses", () => {
    const files = [
      { path: "a.jsonl", raw: `{"uuid":"u1"}\nnot json\n{"uuid":"u2"}\n` },
    ];
    expect(uuidsOf(mergeChainLines(files))).toEqual(["u1", "u2"]);
  });
});
