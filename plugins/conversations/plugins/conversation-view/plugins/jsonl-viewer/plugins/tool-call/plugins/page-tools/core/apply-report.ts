import type { ToolCallEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";

/**
 * What a page write actually did, as `write_agent_note` and `edit_page` report
 * it. The counts are the apply engine's own diff accounting, so they answer the
 * question a reader has after a write: not "was it accepted" but "how much of
 * the page did it move".
 */
export type PageApplyReport = {
  /** The root the apply was made at — the id the caller passed. */
  scope_id: string;
  page_id: string;
  /**
   * The `<agent-note>` cards the write touched. Optional because an earlier
   * revision of these tools reported a single `note_id`, so transcripts from
   * before the rename carry no `note_ids` at all.
   */
  note_ids?: readonly string[];
  survived: number;
  created: number;
  deleted: number;
  moved: number;
  text_edited: number;
  created_ids?: readonly string[];
  /**
   * The pages among `created_ids`: each `<agent-page>` the write minted, by the
   * id that opens it. Optional for the same reason as `note_ids` — older
   * reports predate it.
   */
  created_page_ids?: readonly string[];
  /** `edit_page` only: how many occurrences of `old_string` were replaced. */
  replaced?: number;
};

/**
 * The report a page write returned, or `null` when there is none to read: the
 * call is still in flight, it failed (the content is then a human sentence, not
 * JSON), or the tool returns prose rather than a report — which is exactly what
 * `read_page` does.
 */
export function parsePageApplyReport(
  event: ToolCallEvent,
): PageApplyReport | null {
  if (!event.result?.content || event.result.isError) return null;
  try {
    return JSON.parse(event.result.content);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}
