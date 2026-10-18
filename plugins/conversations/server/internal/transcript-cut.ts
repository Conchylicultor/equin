import {
  activeLineUuids,
  userPromptText,
} from "@plugins/conversations/plugins/transcript-watcher/core";
import type { BackgroundWork, CutLosses, CutRefusal } from "../../core/rewind";

// Cutting a Claude Code transcript just before one of the user's own messages.
//
// This is the one place that decides what a rewind keeps and what it loses, so
// the three callers cannot disagree: the Stop button (cut at the last
// unanswered prompt), "Rewind to here" (truncate the live file) and "Fork from
// here" (write the kept lines under a new session id). The preview the user
// confirms is produced by the same call that performs the cut.
//
// Pure on purpose: lines in, lines out. No file, no pane, no database — a
// refusal has to leave the conversation exactly as it was, so everything here
// runs before anything destructive does.

export type CutResult =
  | {
      ok: true;
      /** The transcript lines to keep, in order. NOT always a plain prefix — see below. */
      keptLines: string[];
      /** Text of the removed message, to hand back to the prompt editor. */
      messageText: string;
      /** When the CLI wrote the removed message, or null when its line has no time. */
      messageAt: Date | null;
      losses: CutLosses;
    }
  | { ok: false; reason: CutRefusal };

interface ParsedLine {
  index: number;
  obj: Record<string, unknown>;
  uuid: string | null;
  parentUuid: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

interface RawBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
}

function blocksOf(obj: Record<string, unknown>): RawBlock[] {
  const content = (obj.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is RawBlock => typeof b === "object" && b !== null,
  );
}

const TOOL_USE_ID_IN_NOTIFICATION = /<tool-use-id>([^<]+)<\/tool-use-id>/g;

/** Every tool-use id named by a `<task-notification>` block in this line. */
function reportedToolUseIds(obj: Record<string, unknown>): string[] {
  const texts: string[] = [];
  if (obj.type === "queue-operation") {
    const content = str(obj.content);
    if (content) texts.push(content);
  } else if (obj.type === "user") {
    const content = (obj.message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") texts.push(content);
    for (const b of blocksOf(obj)) {
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
  }
  const ids: string[] = [];
  for (const text of texts) {
    if (!text.includes("<task-notification>")) continue;
    for (const m of text.matchAll(TOOL_USE_ID_IN_NOTIFICATION)) ids.push(m[1]!);
  }
  return ids;
}

/**
 * Is this tool result the "launched, running in the background" receipt rather
 * than the work's actual result? Claude Code stamps it on the line's structured
 * `toolUseResult`: a subagent carries `isAsync` / `status: "async_launched"`, a
 * background shell a `backgroundTaskId`.
 */
function isBackgroundReceipt(obj: Record<string, unknown>): boolean {
  const r = obj.toolUseResult;
  if (typeof r !== "object" || r === null) return false;
  const rec = r as Record<string, unknown>;
  return (
    rec.isAsync === true ||
    rec.status === "async_launched" ||
    typeof rec.backgroundTaskId === "string"
  );
}

function parseLines(rawLines: readonly string[]): ParsedLine[] {
  const parsed: ParsedLine[] = [];
  rawLines.forEach((line, index) => {
    if (!line.trim()) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      // A torn final line (the CLI was mid-append) is not part of the
      // conversation. It stays in `rawLines` and falls where the cut puts it.
      if (!(err instanceof SyntaxError)) throw err;
      return;
    }
    parsed.push({
      index,
      obj,
      uuid: str(obj.uuid),
      parentUuid: str(obj.parentUuid),
    });
  });
  return parsed;
}

/** Cut just before the user message whose transcript line has this uuid. */
export function cutTranscriptAt(
  rawLines: readonly string[],
  userMessageUuid: string,
): CutResult {
  const parsed = parseLines(rawLines);
  const target = parsed.find((p) => p.uuid === userMessageUuid);
  if (!target) return { ok: false, reason: "not-found" };
  const active = activeLineUuids(parsed.map((p) => p.obj));
  const messageText = userPromptText(target.obj);
  if (messageText === null || !active.has(userMessageUuid)) {
    return { ok: false, reason: "not-a-live-user-prompt" };
  }
  const { cut, conversationLeft } = cutAt(
    rawLines,
    parsed,
    active,
    target,
    messageText,
  );
  return conversationLeft ? cut : { ok: false, reason: "nothing-before" };
}

/**
 * Cut just before the most recent prompt the agent has NOT begun answering, or
 * null when there is none — the Stop button's "give me my prompt back".
 *
 * The prompt is rarely the literal last line: Claude Code appends
 * non-conversation lines (`file-history-snapshot` / `system` / `ai-title` / …)
 * and an interrupt sentinel (`[Request interrupted by user]`) after it. So scan
 * backwards over the live conversation, skipping that trailing noise, and stop
 * at an assistant turn or a tool result: a prompt the agent has already begun
 * answering must not be popped back.
 */
export function cutTranscriptAtUnansweredPrompt(
  rawLines: readonly string[],
): Extract<CutResult, { ok: true }> | null {
  // The Stop button pops a prompt the agent never started on, so — unlike a
  // rewind — an empty remainder is fine: the live process still holds the
  // session and nothing is resumed from this file.
  const parsed = parseLines(rawLines);
  const active = activeLineUuids(parsed.map((p) => p.obj));
  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i]!;
    if (p.uuid && !active.has(p.uuid)) continue; // abandoned rewind branch
    if (p.obj.type === "assistant") return null; // agent already responding
    if (p.obj.type !== "user") continue; // file-history-snapshot / system / …
    // A tool result means the agent is mid-turn; nothing to pop.
    if (blocksOf(p.obj).some((b) => b.type === "tool_result")) return null;
    const messageText = userPromptText(p.obj);
    if (messageText === null) continue; // interrupt sentinel, meta turn, …
    return cutAt(rawLines, parsed, active, p, messageText).cut;
  }
  return null;
}

function cutAt(
  rawLines: readonly string[],
  parsed: readonly ParsedLine[],
  active: ReadonlySet<string>,
  target: ParsedLine,
  messageText: string,
): { cut: Extract<CutResult, { ok: true }>; conversationLeft: boolean } {
  const cutIndex = target.index;
  const byUuid = new Map<string, ParsedLine>();
  for (const p of parsed) if (p.uuid) byUuid.set(p.uuid, p);

  // The chosen message's ancestors: the conversation the model will see again.
  const ancestors = new Set<string>();
  let lastAncestorIndex = -1;
  for (
    let cur = target.parentUuid ? byUuid.get(target.parentUuid) : undefined;
    cur && cur.uuid && !ancestors.has(cur.uuid);
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined
  ) {
    ancestors.add(cur.uuid);
    lastAncestorIndex = Math.max(lastAncestorIndex, cur.index);
  }

  const dropped = new Set<number>();

  // A native `/rewind` leaves the abandoned attempt in the file, and the CLI
  // resumes from the file-order-latest leaf (our viewer instead drops a prompt
  // superseded by a later sibling, but the CLI is what reads this file next). An
  // abandoned attempt written AFTER the last kept ancestor would therefore
  // become the conversation once everything behind it is cut away. Drop those
  // lines; side annotations (attachments, system notes) hanging off the kept
  // path stay.
  const divergesThroughATurn = (line: ParsedLine): boolean => {
    const seen = new Set<string>();
    for (
      let cur: ParsedLine | undefined = line;
      cur && cur.uuid && !ancestors.has(cur.uuid) && !seen.has(cur.uuid);
      cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined
    ) {
      seen.add(cur.uuid);
      if (cur.obj.type === "user" || cur.obj.type === "assistant") return true;
      if (!cur.parentUuid) return false; // another root tree — an earlier segment
    }
    return false;
  };
  for (const p of parsed) {
    if (p.index <= lastAncestorIndex || p.index >= cutIndex || !p.uuid)
      continue;
    if (divergesThroughATurn(p)) dropped.add(p.index);
  }

  // Queue bookkeeping. `enqueue` carries the queued text, `dequeue` pops the
  // head, `remove` withdraws one by content. A queued entry still pending where
  // the file now ends would be a message waiting for a process that never saw
  // it, so the kept file must end with an empty queue. The removed prompt's own
  // enqueue/dequeue pair goes with it, or a "Sent to agent" row outlives the
  // message it announced.
  const pending: ParsedLine[] = [];
  const pairedEnqueue = new Map<number, ParsedLine>(); // dequeue index → its enqueue
  for (const p of parsed) {
    if (p.index >= cutIndex) break;
    if (p.obj.type !== "queue-operation") continue;
    const op = p.obj.operation;
    if (op === "enqueue") {
      pending.push(p);
    } else if (op === "dequeue") {
      const head = pending.shift();
      if (head) pairedEnqueue.set(p.index, head);
    } else if (op === "remove") {
      const content = str(p.obj.content);
      const at = pending.findIndex((e) => str(e.obj.content) === content);
      if (at >= 0) pending.splice(at, 1);
    }
  }
  for (const p of pending) dropped.add(p.index);
  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i]!;
    if (p.index >= cutIndex) continue;
    if (p.obj.type !== "queue-operation") break; // only the block touching the cut
    const enqueue = pairedEnqueue.get(p.index);
    if (enqueue && str(enqueue.obj.content)?.trim() === messageText.trim()) {
      dropped.add(p.index);
      dropped.add(enqueue.index);
    }
  }

  // Losses, read off the live conversation only.
  const launches = new Map<string, BackgroundWork & { index: number }>();
  const background = new Set<string>();
  const firstReportIndex = new Map<string, number>();
  let laterUserTurns = 0;
  for (const p of parsed) {
    const live = !p.uuid || active.has(p.uuid);
    if (!live) continue;
    if (p.obj.type === "assistant") {
      for (const b of blocksOf(p.obj)) {
        if (b.type !== "tool_use" || typeof b.id !== "string") continue;
        const input = (b.input ?? {}) as Record<string, unknown>;
        launches.set(b.id, {
          index: p.index,
          toolUseId: b.id,
          tool: str(b.name) ?? "",
          description: str(input.description) ?? "",
        });
        if (input.run_in_background === true) background.add(b.id);
      }
    }
    if (p.obj.type === "user" && isBackgroundReceipt(p.obj)) {
      for (const b of blocksOf(p.obj)) {
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          background.add(b.tool_use_id);
        }
      }
    }
    for (const id of reportedToolUseIds(p.obj)) {
      if (!firstReportIndex.has(id)) firstReportIndex.set(id, p.index);
    }
    if (p.index > cutIndex && userPromptText(p.obj) !== null) laterUserTurns++;
  }

  const lostReports: BackgroundWork[] = [];
  const unreported: BackgroundWork[] = [];
  for (const [id, launch] of launches) {
    if (launch.index >= cutIndex) continue; // launched after the cut: simply gone
    const reportedAt = firstReportIndex.get(id);
    const work = {
      toolUseId: launch.toolUseId,
      tool: launch.tool,
      description: launch.description,
    };
    if (reportedAt === undefined) {
      if (background.has(id)) unreported.push(work);
    } else if (reportedAt >= cutIndex) {
      lostReports.push(work);
    }
  }

  const keptLines = rawLines.filter(
    (line, index) =>
      index < cutIndex && !dropped.has(index) && line.trim() !== "",
  );
  const conversationLeft = parsed.some(
    (p) =>
      p.index < cutIndex &&
      !dropped.has(p.index) &&
      (p.obj.type === "user" || p.obj.type === "assistant"),
  );
  const stamp = str(target.obj.timestamp);
  return {
    cut: {
      ok: true,
      keptLines,
      messageText,
      messageAt: stamp === null ? null : new Date(stamp),
      losses: { laterUserTurns, lostReports, unreported },
    },
    conversationLeft,
  };
}
