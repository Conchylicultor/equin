#!/usr/bin/env bun
// One SDK agent process: a conversation's Claude Code session, run headless
// through the Agent SDK instead of typed into the interactive UI.
//
//   options   → <dir>/launch.json   (AgentLaunchOptions, written by the backend)
//   commands  → --socket            (newline-delimited JSON, core/protocol.ts)
//   events    ← <dir>/events.jsonl  (every SDK message, numbered, unchanged)
//   stdout    → a human-readable log: what the terminal button shows
//
// A dumb relay: it never interprets Claude's messages beyond what it needs for
// the log; the event file is the contract, so a backend that was down replays
// from its cursor. Launched detached inside tmux (supervisor + viewer only —
// nothing types into it; the terminal button attaches read-only). It exits only
// through `shutdown` (or SIGTERM / SIGHUP from tmux): SIGINT is ignored, so a
// stray Ctrl-C in the pane cannot kill the agent and its CLI.
import {
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  AGENT_EVENTS_FILE,
  AGENT_OPTIONS_FILE,
  AgentCommandSchema,
  AgentLaunchOptionsSchema,
  PROTOCOL_VERSION,
  type AgentAnswer,
  type AgentCommand,
  type AgentEvent,
  type CommandReply,
  type HelloReply,
  type OpenRequest,
} from "../core";

const { values: args } = parseArgs({
  options: {
    dir: { type: "string" },
    socket: { type: "string" },
  },
});
if (!args.dir || !args.socket)
  throw new Error("agent: --dir and --socket are required");
const dir = args.dir;
mkdirSync(dir, { recursive: true });
const eventsPath = join(dir, AGENT_EVENTS_FILE);
const socketPath = args.socket;
mkdirSync(dirname(socketPath), { recursive: true });
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

// ── human log (the terminal button's view) ────────────────────────────────
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);
function log(line: string): void {
  process.stdout.write(
    `${dim(new Date().toISOString().slice(11, 19))} ${line}\n`,
  );
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
          log(
            `\x1b[36m⏺ ${block.name}\x1b[0m ${clip(JSON.stringify(block.input))}`,
          );
      }
      return;
    case "user":
      if (Array.isArray(msg.message.content))
        for (const block of msg.message.content)
          if (typeof block === "object" && block.type === "tool_result")
            log(
              dim(
                `  ⎿ ${clip(typeof block.content === "string" ? block.content : JSON.stringify(block.content), 160)}`,
              ),
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
    case "stream_event":
    case "tool_progress":
    case "tool_use_summary":
      // Recorded in events.jsonl; nothing a human reading the pane needs.
      return;
  }
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
  log(`\x1b[1m› ${clip(text)}\x1b[0m`);
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
    `\x1b[33m? ${toolName}\x1b[0m ${clip(JSON.stringify(input))} — waiting for an answer (${requestId})`,
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
    // sources (CLAUDE.md, hooks, guards, MCP servers).
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: options.settingSources,
    settings: options.settings,
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.strictMcpConfig ? { strictMcpConfig: true } : {}),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    canUseTool,
    enableFileCheckpointing: true,
    pathToClaudeCodeExecutable: options.claudeBin,
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { extraArgs: { effort: options.effort } } : {}),
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
    stderr: (data: string) => process.stderr.write(dim(data)),
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
      };
      return reply;
    }
    case "turn":
      return { promptUuid: pushInput(cmd.text, cmd.turnId) };
    case "interrupt":
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
    case "shutdown":
      setTimeout(() => shutdown("shutdown command"), 0);
      return;
  }
}

function serve(conn: Socket): void {
  let buf = "";
  conn.on("data", (chunk) => {
    buf += chunk.toString();
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const reply = (r: CommandReply) => conn.write(JSON.stringify(r) + "\n");
      const parsed = AgentCommandSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        reply({ ok: false, error: parsed.error.message });
        continue;
      }
      run(parsed.data).then(
        (result) => reply({ ok: true, result }),
        (err: unknown) =>
          reply({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
      );
    }
  });
  conn.on("error", (err) => log(dim(`socket client error: ${err.message}`)));
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
  session.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
process.on("SIGINT", () =>
  log(dim("SIGINT ignored — the agent stops only through the app")),
);

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
log(`● agent ${process.pid} · ${dir}`);
if (options.prompt !== null) pushInput(options.prompt, null);

for await (const msg of session) {
  emit({ kind: "sdk", payload: msg });
  logMessage(msg);
}
shutdown("SDK stream ended");
