/**
 * A transcript is matched by its session-relative path, not by the project
 * dir that holds it (`transcript-key.ts`): the data-root move renamed the
 * dirs under the rows that had counted their files.
 *
 * Run: `./equin test plugins/conversations/plugins/usage`
 */
import { describe, expect, test } from "bun:test";
import type { FileScan } from "./scan";
import { rekeyStoredRows, transcriptKey } from "./transcript-key";

const S = "0b6c2f0e-3a51-4d0c-9c1e-6f2a1b7d9e40";
const OLD = "/u/.claude/projects/-Users-u--oldroot-state-ws-a";
const NEW = "/u/.claude/projects/-Users-u--newroot-state-ws-a";

const row = (path: string, offset: number): FileScan => ({
  path,
  kind: "session",
  offset,
  buckets: [],
  tailHashes: [],
});

describe("transcriptKey", () => {
  test("is the path from the session segment on, whatever dir holds it", () => {
    expect(transcriptKey(`${OLD}/${S}.jsonl`)).toBe(`${S}.jsonl`);
    expect(transcriptKey(`${NEW}/${S}.jsonl`)).toBe(`${S}.jsonl`);
    expect(transcriptKey(`${OLD}/${S}/subagents/agent-x.jsonl`)).toBe(
      `${S}/subagents/agent-x.jsonl`,
    );
    expect(
      transcriptKey(`${NEW}/${S}/subagents/workflows/wf_1/agent-y.jsonl`),
    ).toBe(`${S}/subagents/workflows/wf_1/agent-y.jsonl`);
  });

  test("a path with no session segment is its own key", () => {
    expect(transcriptKey("/p/s.jsonl")).toBe("/p/s.jsonl");
  });
});

describe("rekeyStoredRows", () => {
  test("a reached path takes over the row stored under its old spelling", () => {
    const old = row(`${OLD}/${S}.jsonl`, 120);
    const { byPath, moved, dropped } = rekeyStoredRows(
      new Map([[old.path, old]]),
      [`${NEW}/${S}.jsonl`],
    );
    expect([...byPath.keys()]).toEqual([`${NEW}/${S}.jsonl`]);
    expect(byPath.get(`${NEW}/${S}.jsonl`)).toEqual({
      ...old,
      path: `${NEW}/${S}.jsonl`,
    });
    expect(moved.get(`${NEW}/${S}.jsonl`)).toBe(old);
    expect(dropped).toEqual([]);
  });

  test("a transcript counted under both spellings drops the old row", () => {
    const old = row(`${OLD}/${S}.jsonl`, 120);
    const fresh = row(`${NEW}/${S}.jsonl`, 130);
    const { byPath, moved, dropped } = rekeyStoredRows(
      new Map([
        [old.path, old],
        [fresh.path, fresh],
      ]),
      [fresh.path],
    );
    expect([...byPath.values()]).toEqual([fresh]);
    expect(moved.size).toBe(0);
    expect(dropped).toEqual([old]);
  });

  test("of two old spellings, the one read furthest moves", () => {
    const a = row(`${OLD}/${S}.jsonl`, 10);
    const b = row(`/u/.claude/projects/-other/${S}.jsonl`, 50);
    const { moved, dropped } = rekeyStoredRows(
      new Map([
        [a.path, a],
        [b.path, b],
      ]),
      [`${NEW}/${S}.jsonl`],
    );
    expect(moved.get(`${NEW}/${S}.jsonl`)).toBe(b);
    expect(dropped).toEqual([a]);
  });

  test("an unreached transcript keeps its row", () => {
    const gone = row(`${OLD}/${S}/subagents/agent-x.jsonl`, 5);
    const { byPath, moved, dropped } = rekeyStoredRows(
      new Map([[gone.path, gone]]),
      [`${NEW}/${S}.jsonl`],
    );
    expect([...byPath.values()]).toEqual([gone]);
    expect(moved.size).toBe(0);
    expect(dropped).toEqual([]);
  });
});
