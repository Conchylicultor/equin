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
//
// v2: `answer` carries the AskUserQuestion tool's whole answer shape, `dismiss`
// withdraws a question, `turn_started` / `ready` events, `toolUseId` on a
// permission request, `cliVersion` and `ready` in `hello`.
//
// Additions that an older peer can ignore do not bump the version (every
// running agent would then refuse every command): an agent advertises them in
// `hello` (`stream`, `contextUsage`), and a backend uses them only when
// advertised.
export const PROTOCOL_VERSION = 2;

/**
 * The answer in the AskUserQuestion tool's own input shape — what the agent
 * merges into `updatedInput` (question-relay's `CliAnswer`).
 */
export const AgentAnswerSchema = z.object({
  answers: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.object({ notes: z.string() })).optional(),
  response: z.string().optional(),
});
export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;

export const AgentCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.number().int() }),
  /** A user turn. `turnId` is the backend's, echoed in the `turn_started` event. */
  z.object({
    type: z.literal("turn"),
    turnId: z.string().nullable(),
    text: z.string(),
  }),
  z.object({ type: z.literal("interrupt") }),
  /** Resolves the open `permission_request` with this id. */
  z.object({
    type: z.literal("answer"),
    requestId: z.string(),
    answer: AgentAnswerSchema,
  }),
  /**
   * Withdraws the open `permission_request` with this id: the tool is denied
   * and the turn interrupted (the user said something else instead). A request
   * no longer open is not an error — `dismissed: false` in the reply.
   */
  z.object({ type: z.literal("dismiss"), requestId: z.string() }),
  z.object({ type: z.literal("setModel"), model: z.string().optional() }),
  /** Restores the worktree's files to their state before that user message. */
  z.object({ type: z.literal("rewindFiles"), userMessageId: z.string() }),
  z.object({ type: z.literal("shutdown") }),
  /**
   * Stream the partial message (core/partial.ts): the reply is the message
   * being written now (`SubscribeReply`), then the connection stays open and
   * carries one `PartialStreamLine` per change until either side closes it.
   * Only sent to an agent whose `hello` says `stream: true`.
   */
  z.object({ type: z.literal("subscribe") }),
  /**
   * What fills the context window now: the SDK's `getContextUsage()` (its
   * cheap `summary` detail), relayed unchanged. Only sent to an agent whose
   * `hello` says `contextUsage: true`.
   */
  z.object({ type: z.literal("contextUsage") }),
]);
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

export const CommandReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type CommandReply = z.infer<typeof CommandReplySchema>;

/** One AskUserQuestion call parked in `canUseTool`, waiting for an answer. */
export const OpenRequestSchema = z.object({
  requestId: z.string(),
  /** The tool call's id (`canUseTool`'s `toolUseID`) — the question relay's key. */
  toolUseId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
});
export type OpenRequest = z.infer<typeof OpenRequestSchema>;

/** `hello`'s reply. */
export const HelloReplySchema = z.object({
  version: z.number().int(),
  pid: z.number().int(),
  /** The last event seq the agent wrote. */
  seq: z.number().int(),
  /** The CLI finished its initialize: the agent can take a turn. */
  ready: z.boolean(),
  /** The CLI's version (its initialize reply), null until `ready`. */
  cliVersion: z.string().nullable(),
  openRequests: z.array(OpenRequestSchema),
  /** The agent takes `subscribe`. Absent from an agent started before it existed. */
  stream: z.literal(true).optional(),
  /** The agent takes `contextUsage`. Absent from an agent started before it existed. */
  contextUsage: z.literal(true).optional(),
});
export type HelloReply = z.infer<typeof HelloReplySchema>;

/** `turn`'s reply: the user message's uuid, which the transcript entry carries. */
export const TurnReplySchema = z.object({ promptUuid: z.string() });

/** `dismiss`'s reply. */
export const DismissReplySchema = z.object({ dismissed: z.boolean() });

const envelope = { seq: z.number().int(), t: z.number() };

/**
 * The agent's own lifecycle, as `agent` event payloads:
 * - `started` — the process is up (its pid, what it resumed);
 * - `ready` — the CLI finished its initialize (its version);
 * - `turn_started` — the SDK took a user turn off the input queue: the turn is
 *   submitted (the ledger confirms it from this) and the agent is working;
 * - `exited` — the process is going away.
 */
export const AgentLifecycleSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("started"),
    pid: z.number().int(),
    resume: z.string().nullable(),
    resumeAt: z.string().nullable(),
    fork: z.boolean(),
  }),
  z.object({ event: z.literal("ready"), cliVersion: z.string().nullable() }),
  z.object({
    event: z.literal("turn_started"),
    turnId: z.string().nullable(),
    promptUuid: z.string(),
    text: z.string(),
  }),
  z.object({ event: z.literal("exited"), reason: z.string() }),
  // After `exited`: process.exit returned, did not end the process within the
  // grace period, or a SIGTERM came first. Written by the hard exit just
  // before it SIGKILLs the CLI and the agent; the backend reports it.
  z.object({
    event: z.literal("exit_stalled"),
    trigger: z.enum(["exit-returned", "watchdog", "sigterm"]),
    reason: z.string(),
    /** The shutdown step reached. */
    stage: z.string(),
    runtime: z.string(),
    cli: z
      .object({
        pid: z.number().int().nullable(),
        exitCode: z.number().int().nullable(),
        signalCode: z.string().nullable(),
      })
      .nullable(),
    /** A native stack sample of the stalled process (`/usr/bin/sample`). */
    samplePath: z.string().nullable(),
    sampleError: z.string().nullable(),
  }),
]);
export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;

/**
 * One line of `events.jsonl`. `seq` is gap-free from 1 across the agent's
 * restarts (a restarted agent continues its predecessor's numbering), so a
 * reader's cursor is "the last seq I applied".
 *
 * - `sdk`: an SDK message, relayed unchanged — the agent never interprets it.
 * - `permission_request`: `canUseTool` is parked waiting for an `answer` (or a
 *   `dismiss`); replaying the file re-surfaces it.
 * - `permission_resolved`: the request above was answered, dismissed, or
 *   withdrawn by the SDK (the turn was interrupted).
 * - `agent`: the process's own lifecycle (`AgentLifecycleSchema`).
 */
export const AgentEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("sdk"), payload: z.unknown() }),
  z.object({
    ...envelope,
    kind: z.literal("permission_request"),
    payload: OpenRequestSchema,
  }),
  z.object({
    ...envelope,
    kind: z.literal("permission_resolved"),
    payload: z.object({
      requestId: z.string(),
      toolUseId: z.string(),
      outcome: z.enum(["answered", "dismissed", "aborted"]),
    }),
  }),
  z.object({
    ...envelope,
    kind: z.literal("agent"),
    payload: AgentLifecycleSchema,
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/**
 * The events file inside an agent's directory. The socket is NOT beside it:
 * a kqueue watch of that directory opens every entry, and open(2) on a socket
 * fails (EOPNOTSUPP) — so sockets live in the sockets dir, `agents/<id>.sock`.
 */
export const AGENT_EVENTS_FILE = "events.jsonl";

/** The launch options file inside an agent's directory (`AgentLaunchOptions`). */
export const AGENT_OPTIONS_FILE = "launch.json";

/** One MCP server the launch adds (the workspace's `LaunchMcpServer`). */
const McpServerSchema = z.object({ type: z.literal("http"), url: z.string() });

/**
 * Everything one agent process is started with, written by the backend as one
 * JSON file in the agent's directory — no settings object is ever shell-quoted
 * through tmux. The workspace's typed launch fragment maps onto the SDK's own
 * options one to one.
 */
export const AgentLaunchOptionsSchema = z.object({
  cwd: z.string(),
  /** The system `claude` the SDK runs (`pathToClaudeCodeExecutable`). */
  claudeBin: z.string(),
  /** The CLI's `--model` value. */
  model: z.string().nullable(),
  /** The CLI's `--effort` value. */
  effort: z.string().nullable(),
  /** The one merged settings object (`--settings`). */
  settings: z.record(z.string(), z.unknown()),
  settingSources: z.array(z.enum(["user", "project", "local"])),
  mcpServers: z.record(z.string(), McpServerSchema).nullable(),
  strictMcpConfig: z.boolean(),
  resume: z.string().nullable(),
  /** With `resume`: keep the session only up to this message (a rewind). */
  resumeAt: z.string().nullable(),
  /** With `resumeAt`: the prompt uuid the rewind drops. */
  resumeDropsTurn: z.string().nullable(),
  fork: z.boolean(),
  /**
   * The session this launch runs under, decided before it starts — so the
   * conversation knows its transcript at launch, as a tmux one does, not only
   * once the first turn's `system/init` arrives. The resumed session itself,
   * unless forking; otherwise a fresh id the agent hands the SDK
   * (`sessionId`).
   */
  sessionId: z.string(),
  /**
   * The first turn, queued at start. In the file rather than sent over the
   * socket so a launch retried after a crash never loses it: a running agent
   * already took it, a new one takes it from here.
   */
  prompt: z.string().nullable(),
  /**
   * Added after Claude Code's own system prompt (`systemPrompt.append` on the
   * `claude_code` preset), never in its place: the launch's instructions (a
   * preprompt). Kept here, so a relaunch of the same agent (a rewind) keeps
   * them. Defaulted for an options file written before the field existed —
   * those sessions carry their instructions in the transcript instead.
   */
  appendSystemPrompt: z.string().nullable().default(null),
});
export type AgentLaunchOptions = z.infer<typeof AgentLaunchOptionsSchema>;
