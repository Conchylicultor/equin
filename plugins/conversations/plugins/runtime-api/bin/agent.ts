#!/usr/bin/env bun
// One SDK agent process: a conversation's Claude Code session, run headless
// through the Agent SDK instead of typed into the interactive UI.
//
//   commands  → --socket           (newline-delimited JSON, core/protocol.ts)
//   events    ← <dir>/events.jsonl (every SDK message, numbered, unchanged)
//   stdout    → a human-readable log: what the terminal button shows
//
// It never interprets Claude's messages beyond what it needs for the log; the
// event file is the contract, so a backend that was down replays from its
// cursor. Launched detached inside tmux (supervisor + viewer only — nothing
// types into it). SPIKE: see research/2026-10-19-conversations-sdk-agent-spike.md.
import {
  query,
  type CanUseTool,
  type HookCallback,
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
  AgentCommandSchema,
  PROTOCOL_VERSION,
  type AgentCommand,
  type AgentEvent,
  type CommandReply,
} from "../core";

const { values: args } = parseArgs({
  options: {
    dir: { type: "string" },
    socket: { type: "string" },
    cwd: { type: "string" },
    resume: { type: "string" },
    "resume-at": { type: "string" },
    "resume-drops-turn": { type: "string" },
    fork: { type: "boolean", default: false },
    model: { type: "string" },
    "claude-bin": { type: "string" },
    // Which interception the AskUserQuestion experiment arms: the SDK's
    // canUseTool callback, an in-process PreToolUse hook, or both.
    ask: { type: "string", default: "canUseTool" },
  },
});
if (!args.dir || !args.cwd || !args.socket)
  throw new Error("agent: --dir, --socket and --cwd are required");
const dir = args.dir;
mkdirSync(dir, { recursive: true });
const eventsPath = join(dir, AGENT_EVENTS_FILE);
const socketPath = args.socket;
mkdirSync(dirname(socketPath), { recursive: true });

// ── events.jsonl ──────────────────────────────────────────────────────────
// Resumes numbering from the file, so a restarted agent (same dir) keeps the
// sequence gap-free for readers holding a cursor.
let seq = (() => {
  let text: string;
  try {
    text = readFileSync(eventsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  const lines = text.trimEnd().split("\n").filter(Boolean);
  return lines.length === 0 ? 0 : (JSON.parse(lines.at(-1)!) as AgentEvent).seq;
})();
// A bounded sink (rotates at 128 MB). Phase 1 must reconcile rotation with
// cursor replay; a spike conversation stays far below the cap.
const events = defineFileSink({
  id: `sdk-agent-events:${basename(dir)}`,
  description:
    "One SDK agent's numbered event log, replayed by the backend from its cursor",
  path: eventsPath,
});

type EventBody = Omit<AgentEvent, "seq" | "t">;
function emit(body: EventBody): void {
  const line: AgentEvent = { seq: ++seq, t: Date.now(), ...body } as AgentEvent;
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
const pendingInput: SDKUserMessage[] = [];
let wakeInput: (() => void) | undefined;
let closed = false;
async function* inputStream(): AsyncGenerator<SDKUserMessage> {
  while (!closed) {
    const next = pendingInput.shift();
    if (next) {
      yield next;
      continue;
    }
    await new Promise<void>((resolve) => (wakeInput = resolve));
  }
}
/** Queues a user turn; its uuid is the transcript entry's (rewind targets it). */
function pushInput(
  text: string,
): `${string}-${string}-${string}-${string}-${string}` {
  const uuid = crypto.randomUUID();
  pendingInput.push({
    type: "user",
    uuid,
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  });
  wakeInput?.();
  return uuid;
}

// ── parked questions: canUseTool / PreToolUse wait here for an `answer` ───
const parked = new Map<string, (answers: Record<string, string>) => void>();
/** The open requests, for `hello`: a backend that reconnects learns them without replaying. */
const openRequests = new Map<
  string,
  { via: string; toolName: string; input: unknown }
>();
function park(
  via: "canUseTool" | "preToolUse",
  toolName: string,
  input: unknown,
  signal: AbortSignal,
) {
  const requestId = crypto.randomUUID();
  emit({
    kind: "permission_request",
    payload: { requestId, via, toolName, input },
  });
  openRequests.set(requestId, { via, toolName, input });
  log(
    `\x1b[33m? ${toolName} via ${via}\x1b[0m ${clip(JSON.stringify(input))} — waiting for an answer (${requestId})`,
  );
  return new Promise<Record<string, string> | undefined>((resolve) => {
    parked.set(requestId, (answers) => {
      parked.delete(requestId);
      openRequests.delete(requestId);
      emit({
        kind: "permission_resolved",
        payload: { requestId, outcome: "answered" },
      });
      resolve(answers);
    });
    signal.addEventListener("abort", () => {
      parked.delete(requestId);
      openRequests.delete(requestId);
      emit({
        kind: "permission_resolved",
        payload: { requestId, outcome: "aborted" },
      });
      resolve(undefined);
    });
  });
}

const canUseTool: CanUseTool = async (
  toolName,
  input,
  { signal },
): Promise<PermissionResult> => {
  if (toolName !== "AskUserQuestion")
    return { behavior: "allow", updatedInput: input };
  const answers = await park("canUseTool", toolName, input, signal);
  if (!answers)
    return { behavior: "deny", message: "The question was withdrawn." };
  return { behavior: "allow", updatedInput: { ...input, answers } };
};

const preToolUseAsk: HookCallback = async (input, _toolUseId, { signal }) => {
  if (
    input.hook_event_name !== "PreToolUse" ||
    input.tool_name !== "AskUserQuestion"
  )
    return {};
  const toolInput = input.tool_input as Record<string, unknown>;
  const answers = await park("preToolUse", input.tool_name, toolInput, signal);
  if (!answers) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...toolInput, answers },
    },
  };
};

// ── the session ───────────────────────────────────────────────────────────
const ask = args.ask;
const session = query({
  prompt: inputStream(),
  options: {
    cwd: args.cwd,
    // Exactly the CLI's harness: its system prompt, and every settings source
    // (user + project + local: CLAUDE.md, hooks, guards, MCP servers).
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(ask === "canUseTool" || ask === "both" ? { canUseTool } : {}),
    ...(ask === "preToolUse" || ask === "both"
      ? {
          hooks: {
            PreToolUse: [
              {
                matcher: "AskUserQuestion",
                hooks: [preToolUseAsk],
                timeout: 86_400,
              },
            ],
          },
        }
      : {}),
    includePartialMessages: true,
    enableFileCheckpointing: true,
    ...(args.model ? { model: args.model } : {}),
    ...(args.resume ? { resume: args.resume } : {}),
    ...(args["resume-at"] ? { resumeSessionAt: args["resume-at"] } : {}),
    ...(args["resume-drops-turn"]
      ? { resumeDropsTurn: args["resume-drops-turn"] }
      : {}),
    ...(args.fork ? { forkSession: true } : {}),
    ...(args["claude-bin"]
      ? { pathToClaudeCodeExecutable: args["claude-bin"] }
      : {}),
    stderr: (data: string) => process.stderr.write(dim(data)),
  },
});

// ── command socket ────────────────────────────────────────────────────────
async function run(cmd: AgentCommand): Promise<unknown> {
  switch (cmd.type) {
    case "hello":
      if (cmd.version !== PROTOCOL_VERSION)
        throw new Error(
          `protocol mismatch: agent speaks ${PROTOCOL_VERSION}, backend ${cmd.version}`,
        );
      return {
        version: PROTOCOL_VERSION,
        pid: process.pid,
        seq,
        account: await session.accountInfo(),
        openRequests: [...openRequests].map(([requestId, r]) => ({
          requestId,
          ...r,
        })),
      };
    case "turn": {
      log(`\x1b[1m› ${clip(cmd.text)}\x1b[0m`);
      const promptUuid = pushInput(cmd.text);
      emit({
        kind: "agent",
        payload: { event: "turn_queued", turnId: cmd.turnId, promptUuid },
      });
      return { promptUuid };
    }
    case "interrupt":
      return session.interrupt();
    case "answer": {
      const resolve = parked.get(cmd.requestId);
      if (!resolve) throw new Error(`no open request ${cmd.requestId}`);
      resolve(cmd.answers);
      return;
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

emit({
  kind: "agent",
  payload: {
    event: "started",
    pid: process.pid,
    resume: args.resume ?? null,
    resumeAt: args["resume-at"] ?? null,
    fork: args.fork,
    ask,
  },
});
log(`● agent ${process.pid} · ${dir}`);

for await (const msg of session) {
  // Token deltas are relayed but not logged (the log shows whole messages).
  emit({ kind: "sdk", payload: msg });
  logMessage(msg);
}
shutdown("SDK stream ended");
