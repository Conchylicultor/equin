import {
  parsePageApplyReport,
  type PageApplyReport,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type {
  ArtifactHit,
  Relation,
} from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";

/**
 * This kind's id. Shared by the contribution and every hit it emits — the host
 * throws on a hit filed under another kind's name, and one const is what makes
 * that impossible here.
 */
export const PAGE_KIND = "page";

type ToolCall = Extract<JsonlEvent, { kind: "tool-call" }>;

/**
 * The three page tools, matched the way their renderers match them: on the
 * SUFFIX. An MCP tool arrives named for its server too
 * (`mcp__equin__edit_page`), and the prefix is not ours to predict.
 */
const PAGE_TOOLS: { readonly match: RegExp; readonly writes: boolean }[] = [
  { match: /edit_page$/, writes: true },
  { match: /write_agent_note$/, writes: true },
  { match: /read_page$/, writes: false },
];

/** One string field of a tool call's input, or nothing when it is not one. */
function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Which page the call acted on.
 *
 * The apply report's `page_id` first: `block_id` names the SCOPE of the write —
 * often a card inside a page rather than the page itself — and the report is
 * where the engine says which page that scope resolved to. A call still in
 * flight, or one that failed, has no report, and then the block id is the only
 * name the row can carry.
 */
function pageKey(
  event: ToolCall,
  report: PageApplyReport | null,
): string | undefined {
  // The report is JSON off the wire, so its shape is checked rather than
  // trusted: a tool that answered with some other JSON is not a page id.
  const reported = report?.page_id;
  if (typeof reported === "string" && reported !== "") return reported;
  // `blockId` was the spelling in an earlier revision of these tools; old
  // transcripts carry it.
  return (
    nonEmpty(stringField(event.input, "block_id")) ??
    nonEmpty(stringField(event.input, "blockId"))
  );
}

/**
 * The sub-pages a write minted, by the ids that open them — the report's
 * `created_page_ids`, checked the same way as `page_id`. Only the report knows
 * them: a new page's id does not exist until the write has landed.
 */
function createdPageIds(report: PageApplyReport | null): string[] {
  const ids: unknown = report?.created_page_ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id !== "");
}

/** An empty id is no id — it names nothing a row could open. */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The pages one transcript event touched, and what it did to each.
 *
 * - `write_agent_note` / `edit_page` **edited** the page they wrote into, and
 *   **created** every `<agent-page>` their report says they minted — a new
 *   sub-page is its own row, not a relabelling of its parent.
 * - `read_page` **referenced** the page it read.
 *
 * Known seam: a write is keyed by the page the apply reported, while a read is
 * keyed by whatever `block_id` it was given. So reading one card of a page and
 * then editing the page lists two rows — the page, and the card (titled
 * "<page> › <block type>", opening the block view). Both are real and both open;
 * they merge only once the read carries a report of its own.
 */
export function extractPageHits(event: JsonlEvent): ArtifactHit[] {
  if (event.kind !== "tool-call") return [];
  const tool = PAGE_TOOLS.find((t) => t.match.test(event.name));
  if (tool === undefined) return [];

  // `read_page` answers with prose, never a report.
  const report = tool.writes ? parsePageApplyReport(event) : null;
  const hit = (key: string, relation: Relation): ArtifactHit => ({
    kind: PAGE_KIND,
    key,
    relation,
    at: event.at,
  });

  const key = pageKey(event, report);
  return [
    // A call that names no page at all — nothing to list, and an empty row
    // would be chrome standing in for information the transcript does not have.
    ...(key === undefined
      ? []
      : [hit(key, tool.writes ? "edited" : "referenced")]),
    ...createdPageIds(report).map((id) => hit(id, "created")),
  ];
}
