#!/usr/bin/env bun
// One SDK agent process: a conversation's Claude Code session, run headless
// through the Agent SDK instead of typed into the interactive UI.
//
//   options   → <dir>/launch.json   (AgentLaunchOptions, written by the backend)
//   commands  → --socket            (newline-delimited JSON, core/protocol.ts)
//   events    ← <dir>/events.jsonl  (every SDK message, numbered, unchanged)
//   partial   ← --socket, `subscribe` (the message being streamed, never on disk)
//   pid       → --pid-file          (written at start, removed on exit)
//   usage     → --usage-file        (the subscription's limits, last reported)
//   stdout    → a human-readable log (the backend points it at `agent.log`)
//
// A dumb relay: it never interprets Claude's messages beyond what it needs for
// the log; the event file is the contract, so a backend that was down replays
// from its cursor. Started detached (its own session and process group), so a
// backend restart or crash does not reach it. It exits through `shutdown`, or
// SIGTERM.
import {
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import {
  AGENT_EVENTS_FILE,
  AGENT_OPTIONS_FILE,
  AgentCommandSchema,
  AgentLaunchOptionsSchema,
  PROTOCOL_VERSION,
  claudeUsageOf,
  applyPartialFrame,
  partialFrameOf,
  type AgentAnswer,
  type AgentCommand,
  type AgentEvent,
  type CommandReply,
  type HelloReply,
  type OpenRequest,
  type PartialFrame,
  type PartialMessage,
} from "../core";

const { values: args } = parseArgs({
  options: {
    dir: { type: "string" },
    socket: { type: "string" },
    "pid-file": { type: "string" },
    "usage-file": { type: "string" },
  },
});
if (!args.dir || !args.socket || !args["pid-file"] || !args["usage-file"])
  throw new Error(
    "agent: --dir, --socket, --pid-file and --usage-file are required",
  );
const dir = args.dir;
mkdirSync(dir, { recursive: true });
const eventsPath = join(dir, AGENT_EVENTS_FILE);
const socketPath = args.socket;
mkdirSync(dirname(socketPath), { recursive: true });
const pidPath = args["pid-file"];
const usagePath = args["usage-file"];
const options = AgentLaunchOptionsSchema.parse(
  JSON.parse(readFileSync(join(dir, AGENT_OPTIONS_FILE), "utf8")),
);

// ── events.jsonl ──────────────────────────────────────────────────────────
// Resumes numbering from the file (or, right after a rotation, its newest
// generation), so a restarted agent keeps the sequence gap-free for readers
// holding a cursor.
function lastSeqIn(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const lines = text.split("\n").filter(Boolean);
  // A torn last line (a crash mid-append) is skipped, never numbered over.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return (JSON.parse(lines[i]!) as AgentEvent).seq;
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return null;
}
let seq = lastSeqIn(eventsPath) ?? lastSeqIn(`${eventsPath}.1`) ?? 0;
// A bounded sink (rotates at 128 MB, keeps 3). The backend's reader reads the
// rotated generations before the live file, so rotation and replay agree.
const events = defineFileSink({
  id: `sdk-agent-events:${basename(dir)}`,
  description:
    "One SDK agent's numbered event log, replayed by the backend from its cursor",
  path: eventsPath,
});

type EventBody = Omit<AgentEvent, "seq" | "t">;
function emit(body: EventBody): void {
  const line = { seq: ++seq, t: Date.now(), ...body } as AgentEvent;
  // Written before anyone is told: a backend that crashes after reading a line
  // finds it on replay (the page cache outlives the process; only a host crash
  // would need an fsync).
  events.append(JSON.stringify(line));
}

// ── usage file ──────────────────────────────────────────────────────────────
// The subscription's limits, from each `rate_limit_event`: one machine-wide
// file every agent overwrites (the limits are the account's), written whole
// through a rename so a reader never sees half of it.
function recordUsage(msg: SDKMessage, t: number): void {
  let usage;
  try {
    usage = claudeUsageOf(msg, t);
  } catch (err) {
    // The CLI changed the event's shape: said in the log, never fatal to the
    // agent's turn — a meter is not worth a conversation.
    if (!(err instanceof ZodError)) throw err;
    log(`rate_limit_event did not parse: ${err.message}`);
    return;
  }
  if (!usage) return;
  mkdirSync(dirname(usagePath), { recursive: true });
  const tmp = `${usagePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(usage));
  renameSync(tmp, usagePath);
}

// ── human log (agent.log) ──────────────────────────────────────────────────
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);
function log(line: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
}
function logMessage(msg: SDKMessage): void {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init")
        log(
          `● session ${msg.session_id} · ${msg.model} · auth ${msg.apiKeySource}`,
        );
      return;
    case "assistant":
      for (const block of msg.message.content) {
        if (block.type === "text") log(block.text);
        else if (block.type === "tool_use")
          log(`⏺ ${block.name} ${clip(JSON.stringify(block.input))}`);
      }
      return;
    case "user":
      if (Array.isArray(msg.message.content))
        for (const block of msg.message.content)
          if (typeof block === "object" && block.type === "tool_result")
            log(
              `  ⎿ ${clip(typeof block.content === "string" ? block.content : JSON.stringify(block.content), 160)}`,
            );
      return;
    case "result":
      log(
        `● idle · ${msg.subtype} · ${msg.duration_ms} ms · $${msg.total_cost_usd.toFixed(4)}`,
      );
      return;
    case "auth_status":
    case "conversation_reset":
    case "prompt_suggestion":
    case "rate_limit_event":
    case "stream_event": // the partial message, streamed to subscribers
    case "tool_progress":
    case "tool_use_summary":
      // Recorded in events.jsonl; nothing a human reading the pane needs.
      return;
  }
}

// ── partial message: the message being streamed (thinking, text, tool calls), to `subscribe` connections ──
// Never written to events.jsonl: it is useless on replay, and the finished
// message lands in the transcript anyway. Kept in memory so a subscriber
// joining mid-message starts from what is already written.
let partial: PartialMessage | null = null;
const subscribers = new Set<Socket>();
function pushFrame(frame: PartialFrame): void {
  partial = applyPartialFrame(partial, frame);
  const line = JSON.stringify({ frame }) + "\n";
  for (const conn of subscribers) conn.write(line);
}
/** The message will never land (interrupted, failed): drop its blocks. */
function clearPartial(): void {
  if (partial !== null) pushFrame({ type: "clear" });
}

// ── input queue: socket turns → the SDK's streaming input ─────────────────
interface QueuedTurn {
  message: SDKUserMessage;
  turnId: string | null;
  text: string;
}
const pendingInput: QueuedTurn[] = [];
let wakeInput: (() => void) | undefined;
let closed = false;
async function* inputStream(): AsyncGenerator<SDKUserMessage> {
  while (!closed) {
    const next = pendingInput.shift();
    if (next) {
      // The SDK takes the turn now: it is submitted, and the agent is working.
      emit({
        kind: "agent",
        payload: {
          event: "turn_started",
          turnId: next.turnId,
          promptUuid: next.message.uuid!,
          text: next.text,
        },
      });
      yield next.message;
      continue;
    }
    await new Promise<void>((resolve) => (wakeInput = resolve));
  }
}
/** Queues a user turn; its uuid is the transcript entry's (rewind targets it). */
function pushInput(text: string, turnId: string | null): string {
  const uuid = crypto.randomUUID();
  pendingInput.push({
    message: {
      type: "user",
      uuid,
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    },
    turnId,
    text,
  });
  log(`› ${clip(text)}`);
  wakeInput?.();
  return uuid;
}

// ── parked questions: canUseTool waits here for an `answer` or `dismiss` ──
type Verdict = { kind: "answer"; answer: AgentAnswer } | { kind: "dismiss" };
const parked = new Map<string, (verdict: Verdict) => void>();
/** The open requests, for `hello`: a backend that reconnects learns them without replaying. */
const openRequests = new Map<string, OpenRequest>();

function park(
  toolName: string,
  toolUseId: string,
  input: unknown,
  signal: AbortSignal,
): Promise<Verdict | undefined> {
  const requestId = crypto.randomUUID();
  const request: OpenRequest = { requestId, toolUseId, toolName, input };
  emit({ kind: "permission_request", payload: request });
  openRequests.set(requestId, request);
  log(
    `? ${toolName} ${clip(JSON.stringify(input))} — waiting for an answer (${requestId})`,
  );
  return new Promise<Verdict | undefined>((resolve) => {
    const settle = (
      outcome: "answered" | "dismissed" | "aborted",
      verdict: Verdict | undefined,
    ) => {
      if (!openRequests.delete(requestId)) return;
      parked.delete(requestId);
      emit({
        kind: "permission_resolved",
        payload: { requestId, toolUseId, outcome },
      });
      resolve(verdict);
    };
    parked.set(requestId, (verdict) =>
      settle(verdict.kind === "answer" ? "answered" : "dismissed", verdict),
    );
    signal.addEventListener("abort", () => settle("aborted", undefined));
  });
}

// Must stay set even under bypassPermissions: it still fires for
// AskUserQuestion, and without it the CLI removes AskUserQuestion from the
// tool set. Every other tool is allowed (bypass mode).
const canUseTool: CanUseTool = async (
  toolName,
  input,
  { signal, toolUseID },
): Promise<PermissionResult> => {
  if (toolName !== "AskUserQuestion")
    return { behavior: "allow", updatedInput: input };
  const verdict = await park(toolName, toolUseID, input, signal);
  if (!verdict)
    return { behavior: "deny", message: "The question was withdrawn." };
  if (verdict.kind === "dismiss")
    return {
      behavior: "deny",
      message:
        "The user dismissed the question and is sending a message instead.",
      interrupt: true,
    };
  return { behavior: "allow", updatedInput: { ...input, ...verdict.answer } };
};

// ── the session ───────────────────────────────────────────────────────────
const session = query({
  prompt: inputStream(),
  options: {
    cwd: options.cwd,
    // Exactly the CLI's harness: its system prompt and the launch's settings
    // sources (CLAUDE.md, hooks, guards, MCP servers). The launch's own
    // instructions (a preprompt) are appended to the preset, never replace it.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(options.appendSystemPrompt
        ? { append: options.appendSystemPrompt }
        : {}),
    },
    settingSources: options.settingSources,
    settings: options.settings,
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.strictMcpConfig ? { strictMcpConfig: true } : {}),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    canUseTool,
    // Stream events carry the text as the model writes it (the partial
    // message); they are folded here and never written to events.jsonl.
    includePartialMessages: true,
    enableFileCheckpointing: true,
    pathToClaudeCodeExecutable: options.claudeBin,
    ...(options.model ? { model: options.model } : {}),
    // Thinking text is requested explicitly: under the SDK the CLI ignores
    // the `showThinkingSummaries` setting (the interactive CLI honours it), so
    // without the flag the API omits it and every thinking block arrives
    // empty. The flag, not `thinking: { display }`, so the CLI still picks
    // the thinking type per model.
    extraArgs: {
      "thinking-display": "summarized",
      ...(options.effort ? { effort: options.effort } : {}),
    },
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.resumeAt ? { resumeSessionAt: options.resumeAt } : {}),
    ...(options.resumeDropsTurn
      ? { resumeDropsTurn: options.resumeDropsTurn }
      : {}),
    ...(options.fork ? { forkSession: true } : {}),
    // A new session (fresh or forked) takes the id decided at launch; a
    // resumed one keeps its own (the SDK refuses `sessionId` with a plain
    // `resume`).
    ...(options.resume === null || options.fork
      ? { sessionId: options.sessionId }
      : {}),
    stderr: (data: string) => process.stderr.write(data),
  },
});

// Readiness is the CLI's initialize, not `system/init` (which arrives only
// with the first turn).
let cliVersion: string | null = null;
let ready = false;
void session.initializationResult().then(
  (init) => {
    cliVersion = init.claude_code_version ?? null;
    ready = true;
    emit({ kind: "agent", payload: { event: "ready", cliVersion } });
    log(`● ready · claude ${cliVersion ?? "?"}`);
  },
  (err: unknown) => {
    log(`● initialize failed: ${err instanceof Error ? err.message : err}`);
    shutdown("initialize failed");
  },
);

// ── command socket ────────────────────────────────────────────────────────
async function run(cmd: AgentCommand): Promise<unknown> {
  switch (cmd.type) {
    case "hello": {
      if (cmd.version !== PROTOCOL_VERSION)
        throw new Error(
          `protocol mismatch: agent speaks ${PROTOCOL_VERSION}, backend ${cmd.version}`,
        );
      const reply: HelloReply = {
        version: PROTOCOL_VERSION,
        pid: process.pid,
        seq,
        ready,
        cliVersion,
        openRequests: [...openRequests.values()],
        stream: true,
        contextUsage: true,
      };
      return reply;
    }
    case "turn":
      return { promptUuid: pushInput(cmd.text, cmd.turnId) };
    case "interrupt":
      clearPartial();
      return session.interrupt();
    case "answer": {
      const resolve = parked.get(cmd.requestId);
      if (!resolve) throw new Error(`no open request ${cmd.requestId}`);
      resolve({ kind: "answer", answer: cmd.answer });
      return;
    }
    case "dismiss": {
      const resolve = parked.get(cmd.requestId);
      resolve?.({ kind: "dismiss" });
      return { dismissed: resolve !== undefined };
    }
    case "setModel":
      return session.setModel(cmd.model);
    case "rewindFiles":
      return session.rewindFiles(cmd.userMessageId);
    case "contextUsage":
      return session.getContextUsage({ detail: "summary" });
    case "shutdown":
      setTimeout(() => shutdown("shutdown command"), 0);
      return;
    case "subscribe":
      throw new Error("subscribe is answered by the connection, not run");
  }
}

function serve(conn: Socket): void {
  let buf = "";
  // Replies go out in command order — the backend matches the n-th reply to
  // its n-th command — so each command waits for the one before it. A
  // `subscribe` joins the stream at its turn in that order: its snapshot
  // follows every earlier reply, and every frame follows the snapshot.
  let previous: Promise<void> = Promise.resolve();
  const reply = (r: CommandReply) => conn.write(JSON.stringify(r) + "\n");
  async function answer(line: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      reply({ ok: false, error: `not JSON: ${err.message}` });
      return;
    }
    const parsed = AgentCommandSchema.safeParse(json);
    if (!parsed.success) {
      reply({ ok: false, error: parsed.error.message });
      return;
    }
    if (parsed.data.type === "subscribe") {
      reply({ ok: true, result: partial });
      subscribers.add(conn);
      return;
    }
    try {
      reply({ ok: true, result: await run(parsed.data) });
    } catch (err) {
      reply({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  conn.on("data", (chunk) => {
    buf += chunk.toString();
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      previous = previous.then(() => answer(line));
    }
  });
  conn.on("close", () => subscribers.delete(conn));
  conn.on("error", (err) => log(`socket client error: ${err.message}`));
}

rmSync(socketPath, { force: true });
const server = createServer(serve).listen(socketPath);

function shutdown(reason: string): void {
  if (closed) return;
  closed = true;
  log(`● exiting: ${reason}`);
  emit({ kind: "agent", payload: { event: "exited", reason } });
  server.close();
  rmSync(socketPath, { force: true });
  rmSync(pidPath, { force: true });
  session.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));

emit({
  kind: "agent",
  payload: {
    event: "started",
    pid: process.pid,
    resume: options.resume,
    resumeAt: options.resumeAt,
    fork: options.fork,
  },
});
// The pid file is what says "running" to every backend counting agents; a
// crash leaves it behind, so readers check the pid is alive.
mkdirSync(dirname(pidPath), { recursive: true });
writeFileSync(pidPath, `${process.pid}\n`);
log(`● agent ${process.pid} · ${dir}`);
if (options.prompt !== null) pushInput(options.prompt, null);

for await (const msg of session) {
  if (msg.type === "stream_event") {
    const frame = partialFrameOf(msg);
    if (frame) pushFrame(frame);
    continue;
  }
  emit({ kind: "sdk", payload: msg });
  recordUsage(msg, Date.now());
  logMessage(msg);
  // A failed turn's message never lands in the transcript. A successful one
  // does, a few ms later: its text stays until the page sees it there.
  if (msg.type === "result" && msg.is_error) clearPartial();
}
shutdown("SDK stream ended");
