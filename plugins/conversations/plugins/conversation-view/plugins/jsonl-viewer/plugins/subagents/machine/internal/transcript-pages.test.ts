/**
 * A sub-agent's transcript as `subagentTranscript` pages it: the rows within
 * the paged value's key contract (newest first), and the meta carrying the
 * link state and what only the whole transcript knows.
 */

import { describe, expect, test } from "bun:test";
import { sliceRange } from "@plugins/network/plugins/live/server";
import { checkPagedSource } from "@plugins/network/plugins/live/server/testing";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { subagentTranscript, type SubagentTranscript } from "../../core";
import {
  subagentTranscriptMeta,
  subagentTranscriptRows,
} from "./transcript-pages";

const AT = "2026-10-22T10:00:00.000Z";
const prompt = (text: string): JsonlEvent => ({
  kind: "user-text",
  at: AT,
  text,
});
const said = (text: string): JsonlEvent => ({
  kind: "assistant-text",
  at: AT,
  text,
});
const handback = (message: string): JsonlEvent => ({
  kind: "tool-call",
  at: AT,
  toolUseId: `toolu_${message}`,
  name: "SubagentHandback",
  input: { message },
});

const linked: SubagentTranscript = {
  kind: "linked",
  agentId: "a1",
  events: [
    prompt("go"),
    said("on it"),
    handback("first"),
    prompt("again"),
    said("done"),
    handback("final"),
  ],
};
const QUERY = { id: "conv-1", by: "agent" as const, key: "a1" };

describe("subagent transcript pages", () => {
  test("pages within the paged value's key contract, newest first", async () => {
    const items = subagentTranscriptRows(linked);
    await checkPagedSource({
      value: subagentTranscript,
      query: QUERY,
      loader: (_q, range) => sliceRange(subagentTranscript, items, range),
      items,
      limits: [1, 4],
    });
    const page0 = sliceRange(subagentTranscript, items, {
      after: null,
      until: null,
      limit: 2,
    });
    expect(page0.map((r) => r.seq)).toEqual([5, 4]);
    // A tool call keeps its tool-use id as its row id, as jsonl-events' do.
    expect(page0[0]!.id).toBe("tool:toolu_final");
  });

  test("an unlinked or unjoinable sub-agent has no rows; its meta says why", () => {
    const unlinked: SubagentTranscript = { kind: "unlinked" };
    const unjoinable: SubagentTranscript = {
      kind: "unjoinable",
      reason: "two teammates answer to it",
    };
    expect(subagentTranscriptRows(unlinked)).toEqual([]);
    expect(subagentTranscriptRows(unjoinable)).toEqual([]);
    expect(subagentTranscriptMeta(unlinked)).toEqual({ kind: "unlinked" });
    expect(subagentTranscriptMeta(unjoinable)).toEqual(unjoinable);
  });

  test("linked meta: the whole transcript's count, first answer, last handback and prompts", () => {
    const meta = subagentTranscriptMeta(linked);
    expect(meta).toMatchObject({
      kind: "linked",
      agentId: "a1",
      count: 6,
      firstAssistantSeq: 1,
      handback: "final",
    });
    expect(
      meta.kind === "linked" ? meta.prompts.map((p) => p.seq) : null,
    ).toEqual([0, 3]);
  });

  test("the meta parses against its declared schema", () => {
    const meta = subagentTranscriptMeta(linked);
    expect(subagentTranscript.meta.schema.parse(meta)).toEqual(meta);
  });
});
