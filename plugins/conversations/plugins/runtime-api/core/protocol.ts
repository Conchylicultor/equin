import { z } from "zod";

// The wire between a backend and one SDK agent process.
//
// Two channels, one per direction:
//   - commands, backend → agent: newline-delimited JSON on the agent's Unix
//     socket, each answered by one `CommandReply` line;
//   - events, agent → backend: numbered lines appended to `events.jsonl`, which
//     a backend tails from its own cursor, so nothing depends on a live
//     connection and a restarted backend replays what it missed.
//
// Agent processes outlive deploys, so the first command on a connection is
// `hello` with the version the backend speaks; a mismatch is refused, loudly.
export const PROTOCOL_VERSION = 1;

/** One structured answer to an AskUserQuestion: question text → chosen label(s). */
const AnswersSchema = z.record(z.string(), z.string());

export const AgentCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.number().int() }),
  /** A user turn. `turnId` is the backend's, echoed in the `turn_queued` event. */
  z.object({ type: z.literal("turn"), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal("interrupt") }),
  /** Resolves the open `permission_request` with this id. */
  z.object({
    type: z.literal("answer"),
    requestId: z.string(),
    answers: AnswersSchema,
  }),
  z.object({ type: z.literal("setModel"), model: z.string().optional() }),
  /** Restores the worktree's files to their state before that user message. */
  z.object({ type: z.literal("rewindFiles"), userMessageId: z.string() }),
  z.object({ type: z.literal("shutdown") }),
]);
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

export const CommandReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type CommandReply = z.infer<typeof CommandReplySchema>;

/**
 * One line of `events.jsonl`. `seq` is gap-free from 1, so a reader's cursor
 * is "the last seq I applied".
 *
 * - `sdk`: an SDK message, relayed unchanged — the agent never interprets it.
 * - `permission_request`: `canUseTool` (or the PreToolUse fallback) is parked
 *   waiting for an `answer`; replaying the file re-surfaces it.
 * - `permission_resolved`: the request above was answered or withdrawn.
 * - `agent`: the process's own lifecycle (started, turn_queued, exited).
 */
export const AgentEventSchema = z.discriminatedUnion("kind", [
  z.object({
    seq: z.number().int(),
    t: z.number(),
    kind: z.literal("sdk"),
    payload: z.unknown(),
  }),
  z.object({
    seq: z.number().int(),
    t: z.number(),
    kind: z.literal("permission_request"),
    payload: z.object({
      requestId: z.string(),
      via: z.enum(["canUseTool", "preToolUse"]),
      toolName: z.string(),
      input: z.unknown(),
    }),
  }),
  z.object({
    seq: z.number().int(),
    t: z.number(),
    kind: z.literal("permission_resolved"),
    payload: z.object({ requestId: z.string(), outcome: z.string() }),
  }),
  z.object({
    seq: z.number().int(),
    t: z.number(),
    kind: z.literal("agent"),
    payload: z.object({ event: z.string() }).passthrough(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/**
 * The events file inside an agent's directory. The socket is NOT beside it:
 * a kqueue watch of that directory opens every entry, and open(2) on a socket
 * fails (EOPNOTSUPP) — so sockets live in the sockets dir, `agents/<id>.sock`.
 */
export const AGENT_EVENTS_FILE = "events.jsonl";
