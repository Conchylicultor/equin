import { describe, expect, test } from "bun:test";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { extractPageHits, PAGE_KIND } from "./extract";

const PAGE = "block-7f1a2d3d-a3cd-4c21-9a7e-000000000001";
const CARD = "block-11112222-a3cd-4c21-9a7e-000000000002";
const SUB = "block-33334444-a3cd-4c21-9a7e-000000000003";
const AT = "2026-09-19T10:00:00Z";

/** The apply report a page write answers with, as JSON on the wire. */
function report(pageId: string, createdPageIds?: string[]): string {
  return JSON.stringify({
    created_page_ids: createdPageIds,
    scope_id: CARD,
    page_id: pageId,
    survived: 3,
    created: 1,
    deleted: 0,
    moved: 0,
    text_edited: 1,
  });
}

function toolCall(
  name: string,
  input: unknown,
  result?: { content: string; isError?: boolean },
): JsonlEvent {
  return {
    kind: "tool-call",
    at: AT,
    toolUseId: "t-1",
    name,
    input,
    result: result && { at: AT, ...result },
  };
}

/** `(key, relation)` pairs — what a row would read, with the noise dropped. */
function rows(event: JsonlEvent): [string, string][] {
  return extractPageHits(event).map((h) => {
    expect(h.kind).toBe(PAGE_KIND);
    expect(h.at).toBe(AT);
    return [h.key, h.relation];
  });
}

describe("extractPageHits — which tools", () => {
  test("the MCP server prefix does not hide a page tool", () => {
    const event = toolCall(
      "mcp__equin__read_page",
      { block_id: PAGE },
      { content: "# Plan" },
    );
    expect(rows(event)).toEqual([[PAGE, "referenced"]]);
  });

  test("a tool that is not a page tool yields nothing", () => {
    expect(rows(toolCall("Read", { file_path: "/repo/README.md" }))).toEqual(
      [],
    );
    expect(
      rows(toolCall("mcp__other__read_pages", { block_id: PAGE })),
    ).toEqual([]);
  });

  test("an event that is not a tool call is skipped", () => {
    const event: JsonlEvent = {
      kind: "assistant-text",
      at: AT,
      text: `wrote to ${PAGE}`,
    };
    expect(rows(event)).toEqual([]);
  });
});

describe("extractPageHits — relation", () => {
  test("write_agent_note edits the page", () => {
    const event = toolCall(
      "mcp__equin__write_agent_note",
      { block_id: CARD, content: "Findings\n\n- one" },
      { content: report(PAGE) },
    );
    expect(rows(event)).toEqual([[PAGE, "edited"]]);
  });

  test("edit_page edits the page", () => {
    const event = toolCall(
      "mcp__equin__edit_page",
      { block_id: PAGE, old_string: "a", new_string: "b" },
      { content: report(PAGE) },
    );
    expect(rows(event)).toEqual([[PAGE, "edited"]]);
  });

  test("read_page only references it", () => {
    const event = toolCall(
      "mcp__equin__read_page",
      { block_id: PAGE },
      { content: "# Plan\n\nprose, not a report" },
    );
    expect(rows(event)).toEqual([[PAGE, "referenced"]]);
  });

  test("a sub-page the write minted is its own created row", () => {
    const event = toolCall(
      "mcp__equin__edit_page",
      {
        block_id: PAGE,
        old_string: "x",
        new_string: '<agent-page title="Findings">the body</agent-page>',
      },
      { content: report(PAGE, [SUB]) },
    );
    expect(rows(event)).toEqual([
      [PAGE, "edited"],
      [SUB, "created"],
    ]);
  });

  test("a mint still in flight edits the page — the new id is not known yet", () => {
    const event = toolCall("mcp__equin__write_agent_note", {
      block_id: PAGE,
      content: '<agent-page title="Findings">the body</agent-page>',
    });
    expect(rows(event)).toEqual([[PAGE, "edited"]]);
  });

  test("a report without created_page_ids creates nothing", () => {
    const event = toolCall(
      "mcp__equin__edit_page",
      {
        block_id: PAGE,
        old_string: "x",
        new_string: `<agent-page id="${CARD}" title="Findings"/>`,
      },
      { content: report(PAGE) },
    );
    expect(rows(event)).toEqual([[PAGE, "edited"]]);
  });
});

describe("extractPageHits — which key", () => {
  test("the report's page wins over the block the write was scoped to", () => {
    const event = toolCall(
      "mcp__equin__write_agent_note",
      { block_id: CARD, content: "note" },
      { content: report(PAGE) },
    );
    expect(rows(event)).toEqual([[PAGE, "edited"]]);
  });

  test("a write still in flight falls back to the block it was given", () => {
    const event = toolCall("mcp__equin__edit_page", {
      block_id: CARD,
      old_string: "a",
      new_string: "b",
    });
    expect(rows(event)).toEqual([[CARD, "edited"]]);
  });

  test("a refused write falls back too — the refusal is prose, not a report", () => {
    const event = toolCall(
      "mcp__equin__edit_page",
      { block_id: CARD, old_string: "a", new_string: "b" },
      { content: "Refused: instructions not received.", isError: true },
    );
    expect(rows(event)).toEqual([[CARD, "edited"]]);
  });

  test("the legacy `blockId` spelling still names the page", () => {
    const event = toolCall(
      "mcp__equin__read_page",
      { blockId: PAGE },
      { content: "# Plan" },
    );
    expect(rows(event)).toEqual([[PAGE, "referenced"]]);
  });

  test("a call naming no page at all lists nothing", () => {
    expect(rows(toolCall("mcp__equin__read_page", {}))).toEqual([]);
    expect(rows(toolCall("mcp__equin__read_page", { block_id: "" }))).toEqual(
      [],
    );
  });
});
