import {
  isInterruptContent,
  type JsonlEvent,
} from "@plugins/conversations/plugins/transcript-source/core";
import { prototypeIdsIn } from "@plugins/apps/plugins/prototypes/plugins/files/core";

// Pure: everything the end-of-turn job decides from a transcript, with no I/O,
// so the attribution rules are pinned by fixture events rather than by a live
// conversation.

type AssistantText = Extract<JsonlEvent, { kind: "assistant-text" }>;

const SUBJECT_MAX_CHARS = 72;
const BODY_SECTION_MAX_CHARS = 2000;
/** The subject of a turn whose window holds no request at all. */
export const FALLBACK_SUBJECT = "Agent turn";

function isEndTurn(event: JsonlEvent): event is AssistantText {
  return event.kind === "assistant-text" && event.stopReason === "end_turn";
}

export type TurnWindow =
  | {
      kind: "found";
      events: JsonlEvent[];
      /** The closing message's id — the idempotency key of the versions it records. */
      messageId: string | undefined;
    }
  | { kind: "not-found" };

/**
 * One turn's events: everything after the previous end-of-turn assistant
 * message, up to and including the one that closed this turn.
 *
 * The start is the previous `end_turn`, not the previous user message, so a turn
 * the user interrupted (it never reached `end_turn`, so nothing checkpointed it)
 * folds into the next one instead of being lost.
 *
 * - `messageId === null` — the payload type allows it, though the emitter never
 *   sends one. Take the LAST end-of-turn in the transcript: the event means a
 *   turn just ended, and that is the one that did.
 * - a `messageId` the transcript does not hold — the message is not on the live
 *   branch (a rewind abandoned it). `not-found`, so nothing is recorded: guessing
 *   another window would file one turn's changes under another turn's request.
 *   An unclaimed change is not lost — it waits in the folder and goes into the
 *   next version.
 */
export function findTurnWindow(
  events: readonly JsonlEvent[],
  messageId: string | null,
): TurnWindow {
  const closes =
    messageId === null
      ? isEndTurn
      : (e: JsonlEvent): e is AssistantText =>
          e.kind === "assistant-text" && e.messageId === messageId;
  const end = events.findLastIndex(closes);
  // `events[-1]` is undefined, so this one test covers "no such message" too.
  const closing = events[end];
  if (closing === undefined || !closes(closing)) return { kind: "not-found" };
  const start = events.slice(0, end).findLastIndex(isEndTurn) + 1;
  return {
    kind: "found",
    events: events.slice(start, end + 1),
    messageId: closing.messageId,
  };
}

/**
 * Every prototype id named in the inputs of the window's tool calls, first
 * mention first. Whatever the tool: an `Edit`/`Write` path, a `Bash` command,
 * and an `Agent` call's prompt — a subagent's own tool calls live in a separate
 * transcript, so the prompt that delegated the work is the only trace of it
 * here. An id that is not a prototype on disk is harmless: recording it answers
 * `no-such-prototype`.
 *
 * What counts as a mention — the word guard and the leaf walk — is
 * `prototypeIdsIn`, beside the mint it has to agree with. All this adds is
 * which part of the transcript is read: tool-call inputs, and nothing else.
 */
export function touchedPrototypeIds(window: readonly JsonlEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of window) {
    if (event.kind !== "tool-call") continue;
    for (const id of prototypeIdsIn(event.input)) ids.add(id);
  }
  return [...ids];
}

/**
 * What the turn was asked to do: the window's last user message, else the last
 * message relayed from another session (a teammate's request), else the last
 * background-task notification that woke the agent. `null` when the window holds
 * none of them.
 */
export function turnRequest(window: readonly JsonlEvent[]): string | null {
  const user = window.findLast(
    (e) =>
      e.kind === "user-text" &&
      e.text.trim() !== "" &&
      !isInterruptContent(e.text),
  );
  if (user?.kind === "user-text") return user.text.trim();
  const teammate = window.findLast((e) => e.kind === "teammate-message");
  if (teammate?.kind === "teammate-message") return teammate.body.trim();
  const notification = window.findLast((e) => e.kind === "task-notification");
  if (notification?.kind === "task-notification") {
    return notification.summary.trim();
  }
  return null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The version's one-line subject: the request's first non-empty line, ≤ 72 chars. */
export function checkpointSubject(request: string | null): string {
  const line = request
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ? truncate(line, SUBJECT_MAX_CHARS) : FALLBACK_SUBJECT;
}

/** The version's body: the full request and the agent's final message, each truncated. */
export function checkpointBody(
  request: string | null,
  summary: string,
): string {
  const sections: string[] = [];
  if (request !== null) {
    sections.push(`Request:\n${truncate(request, BODY_SECTION_MAX_CHARS)}`);
  }
  const trimmed = summary.trim();
  if (trimmed !== "") {
    sections.push(
      `Agent summary:\n${truncate(trimmed, BODY_SECTION_MAX_CHARS)}`,
    );
  }
  return sections.join("\n\n");
}

export type TurnCheckpointPlan =
  | {
      kind: "checkpoint";
      ids: string[];
      subject: string;
      body: string;
      messageId: string | undefined;
    }
  | { kind: "nothing"; reason: "turn-not-found" | "no-prototype-touched" };

/** Which prototypes this turn touched, and what to record for each. */
export function planTurnCheckpoint(
  events: readonly JsonlEvent[],
  turn: { messageId: string | null; text: string },
): TurnCheckpointPlan {
  const window = findTurnWindow(events, turn.messageId);
  if (window.kind === "not-found") {
    return { kind: "nothing", reason: "turn-not-found" };
  }
  const ids = touchedPrototypeIds(window.events);
  if (ids.length === 0)
    return { kind: "nothing", reason: "no-prototype-touched" };
  const request = turnRequest(window.events);
  return {
    kind: "checkpoint",
    ids,
    subject: checkpointSubject(request),
    body: checkpointBody(request, turn.text),
    messageId: window.messageId,
  };
}
