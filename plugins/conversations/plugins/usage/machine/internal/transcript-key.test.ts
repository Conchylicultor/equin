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

  test("a key is its own key (what the scan tables store)", () => {
    expect(transcriptKey(`${S}.jsonl`)).toBe(`${S}.jsonl`);
    expect(transcriptKey(`${S}/subagents/agent-x.jsonl`)).toBe(
      `${S}/subagents/agent-x.jsonl`,
    );
  });
});

describe("rekeyStoredRows", () => {
  test("a row stored under its key is found under the path the pass reads", () => {
    const keyed = row(`${S}.jsonl`, 120);
    const { byPath, moved, dropped } = rekeyStoredRows(
      [keyed],
      [`${NEW}/${S}.jsonl`],
    );
    expect([...byPath.entries()]).toEqual([
      [`${NEW}/${S}.jsonl`, { ...keyed, path: `${NEW}/${S}.jsonl` }],
    ]);
    expect(moved.size).toBe(0);
    expect(dropped).toEqual([]);
  });

  test("a row stored under an absolute path is taken over, to be rewritten under its key", () => {
    const old = row(`${OLD}/${S}.jsonl`, 120);
    const { byPath, moved, dropped } = rekeyStoredRows(
      [old],
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

  test("a transcript counted under two spellings drops the one read less far", () => {
    const old = row(`${OLD}/${S}.jsonl`, 120);
    const keyed = row(`${S}.jsonl`, 130);
    const { byPath, moved, dropped } = rekeyStoredRows(
      [old, keyed],
      [`${NEW}/${S}.jsonl`],
    );
    expect([...byPath.values()]).toEqual([
      { ...keyed, path: `${NEW}/${S}.jsonl` },
    ]);
    expect(moved.size).toBe(0);
    expect(dropped).toEqual([old]);
  });

  test("on a tie, the row already stored under its key stays", () => {
    const old = row(`${OLD}/${S}.jsonl`, 120);
    const keyed = row(`${S}.jsonl`, 120);
    const { moved, dropped } = rekeyStoredRows(
      [old, keyed],
      [`${NEW}/${S}.jsonl`],
    );
    expect(moved.size).toBe(0);
    expect(dropped).toEqual([old]);
  });

  test("of two absolute spellings, the one read furthest moves", () => {
    const a = row(`${OLD}/${S}.jsonl`, 10);
    const b = row(`/u/.claude/projects/-other/${S}.jsonl`, 50);
    const { moved, dropped } = rekeyStoredRows([a, b], [`${NEW}/${S}.jsonl`]);
    expect(moved.get(`${NEW}/${S}.jsonl`)).toBe(b);
    expect(dropped).toEqual([a]);
  });

  test("an unreached transcript keeps its row, under its key", () => {
    const key = `${S}/subagents/agent-x.jsonl`;
    const keyed = row(key, 5);
    const kept = rekeyStoredRows([keyed], [`${NEW}/${S}.jsonl`]);
    expect([...kept.byPath.entries()]).toEqual([[key, keyed]]);
    expect(kept.moved.size).toBe(0);

    const gone = row(`${OLD}/${key}`, 5);
    const moved = rekeyStoredRows([gone], [`${NEW}/${S}.jsonl`]);
    expect([...moved.byPath.entries()]).toEqual([
      [key, { ...gone, path: key }],
    ]);
    expect(moved.moved.get(key)).toBe(gone);
    expect(moved.dropped).toEqual([]);
  });
});
