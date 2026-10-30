import { blockIdKind } from "@plugins/page/plugins/editor/core";
import {
  attemptIdKind,
  conversationIdKind,
  taskIdKind,
} from "@plugins/tasks/plugins/task-ids/core";

// Every id the film's story names, stamped and carrying `film`
// (`<prefix>-1792800000-filmNN`), so the page's prose recognises a conversation
// id as a chip and a row that leaked anywhere else is findable by eye. Parsed,
// so a shape a kind rejects fails at import rather than as a dead chip.

const STAMP = "1792800000";
const suffix = (n: number) => `film${String(n).padStart(2, "0")}`;

export const filmBlockId = (n: number) =>
  blockIdKind.parse(`block-${STAMP}-${suffix(n)}`);
export const filmTaskId = (n: number) =>
  taskIdKind.parse(`task-${STAMP}-${suffix(n)}`);
export const filmAttemptId = (n: number) =>
  attemptIdKind.parse(`att-${STAMP}-${suffix(n)}`);
export const filmConversationId = (n: number) =>
  conversationIdKind.parse(`conv-${STAMP}-${suffix(n)}`);

/**
 * The session id of a seeded transcript: a fixed UUID per story number, as
 * Claude Code names its session files (`<uuid>.jsonl`).
 */
export const filmSessionId = (n: number) =>
  `f11a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
