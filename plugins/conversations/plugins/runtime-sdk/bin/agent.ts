#!/usr/bin/env bun
// One SDK agent process: a conversation's Claude Code session, run headless
// through the Agent SDK instead of typed into the interactive UI.
//
//   options   → <dir>/launch.json   (AgentLaunchOptions, written by the backend)
//   commands  → --socket            (newline-delimited JSON, core/protocol.ts)
//   events    ← <dir>/events.jsonl  (every SDK message, numbered, unchanged)
//   partial   ← --socket, `subscribe` (the message being streamed, never on disk)
//   pid       → --pid-file          (written at start, removed on exit)
//   account   ← --account           (the Claude account it signs in as)
//   usage     → --usage-file        (that account's limits, last reported)
//   stdout    → a human-readable log (the backend points it at `agent.log`)
//
// A dumb relay: it never interprets Claude's messages beyond what it needs for
// the log; the event file is the contract, so a backend that was down replays
// from its cursor. Started detached (its own session and process group), so a
// backend restart or crash does not reach it. It exits through `shutdown`, or
// SIGTERM — and that exit always happens (see `shutdown`).
import type {
  CanUseTool,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import { SAMPLE } from "@plugins/infra/plugins/paths/server";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ZodError, z } from "zod";
import {
  claudeQuery,
  claudeSessionEnv,
} from "@plugins/infra/plugins/claude-cli/plugins/sdk/server";
import { disclaimArgv } from "@plugins/packages/plugins/spawn-disclaim/core";
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
    account: { type: "string" },
    "usage-file": { type: "string" },
  },
});
if (
  !args.dir ||
  !args.socket ||
  !args["pid-file"] ||
  !args.account ||
  !args["usage-file"]
)
  throw new Error(
    "agent: --dir, --socket, --pid-file, --account and --usage-file are required",
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
// The account's environment: this process's own (the agent session's closed
// list) plus the account's token, fetched by the agent itself from the secrets
// store, so it never sits in an argv, the options file or the login shell's
// environment. Only Claude Code's own process gets it (the session below); the
// system account adds nothing — Claude Code's own login.
const sessionEnv = await claudeSessionEnv(args.account, process.env);

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

// Handing a turn to the SDK is not the agent taking it: the SDK writes it to
// the CLI at once, and a busy CLI parks it in its command queue until the next
// tool boundary (folded into the running turn) or the turn's end. The CLI says
// when it really starts one — a `command_lifecycle` message (untyped in the
// SDK) naming our uuid — and only then is the turn `turn_started`. A CLI that
// never sends one (older than the lifecycle; known once its first `init` came
// with none seen) confirms at hand-off, as before.
const inCliQueue = new Map<string, QueuedTurn>();
let cliReportsLifecycle: boolean | null = null;

function turnStarted(turn: QueuedTurn): void {
  emit({
    kind: "agent",
    payload: {
      event: "turn_started",
      turnId: turn.turnId,
      promptUuid: turn.message.uuid!,
      text: turn.text,
    },
  });
}

const CommandLifecycleSchema = z.object({
  type: z.literal("command_lifecycle"),
  command_uuid: z.string(),
  state: z.string(),
});

/** Confirms the turns the CLI's queue lifecycle says it took. */
function followCliQueue(msg: SDKMessage): void {
  const lifecycle = CommandLifecycleSchema.safeParse(msg);
  if (lifecycle.success) {
    cliReportsLifecycle = true;
    const { command_uuid: uuid, state } = lifecycle.data;
    const turn = inCliQueue.get(uuid);
    if (!turn) return;
    // `completed` without `started`: a command the CLI ran without a turn.
    if (state === "started" || state === "completed") {
      inCliQueue.delete(uuid);
      turnStarted(turn);
    } else if (state === "cancelled") {
      // Nothing here cancels a queued turn; the backend fails it when the
      // agent exits without having taken it.
      inCliQueue.delete(uuid);
      log(`✕ the CLI cancelled a queued turn: ${clip(turn.text)}`);
    }
    return;
  }
  if (
    cliReportsLifecycle === null &&
    msg.type === "system" &&
    msg.subtype === "init"
  ) {
    cliReportsLifecycle = false;
    log("● this CLI reports no command lifecycle: turns confirm at hand-off");
    for (const turn of inCliQueue.values()) turnStarted(turn);
    inCliQueue.clear();
  }
}

async function* inputStream(): AsyncGenerator<SDKUserMessage> {
  while (!closed) {
    const next = pendingInput.shift();
    if (next) {
      if (cliReportsLifecycle === false) turnStarted(next);
      else inCliQueue.set(next.message.uuid!, next);
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
// The CLI child, spawned here rather than by the SDK so the hard exit holds
// its handle: a CLI running a background task keeps going after its stdin
// closes (2026-10-20), so it would outlive an agent that SIGKILLs itself.
let cli: ChildProcessByStdio<Writable, Readable, null> | null = null;
const session = claudeQuery({
  env: sessionEnv,
  // The conversation-named hardlink when the backend made one (so macOS
  // names this agent in a permission prompt), else the Agent SDK's bundled
  // Claude Code the backend resolved.
  bin: options.namedClaudeBin ?? options.claudeBin,
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
    ...(options.model ? { model: options.model } : {}),
    // Thinking text is requested explicitly: under the SDK the CLI ignores
    // the `showThinkingSummaries` setting (the interactive CLI honours it), so
    // without the flag the API omits it and every thinking block arrives
    // empty. The flag, not `thinking: { display }`, so the CLI still picks
    // the thinking type per model. `chrome`: Claude-in-Chrome, which only the
    // interactive CLI enables by default — under the SDK it is off unless
    // asked for. The `prefer-agent-browser` guard (infra/mcp/browser) steers
    // its first use toward the agent browser.
    extraArgs: {
      "thinking-display": "summarized",
      chrome: null,
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
    // Same argv, cwd, env and abort signal the SDK would spawn with — run
    // through `disclaim-exec` when the backend resolved it, which execs the
    // CLI in place (same pid, stdio and signals) as its own responsible
    // process, so macOS names claude, not the gateway, in a permission
    // prompt. Its stderr goes straight to ours (agent.log).
    spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
      const [bin, ...argv] = disclaimArgv(options.disclaimExec, [
        command,
        ...args,
      ]);
      log(
        `● spawning claude: ${bin === command ? command : `${bin} ${command}`}`,
      );
      cli = spawn(bin, argv, {
        cwd,
        env,
        signal,
        stdio: ["pipe", "pipe", "inherit"],
      });
      return cli;
    },
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
        turnIds: true,
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
// `started` is written once the socket answers: the backend reads that line as
// "the agent is up" and asks it `hello` straight after. A failed listen is an
// `error` event with no listener — a crash, loud.
const listening = new Promise<void>((resolve) => {
  server.once("listening", () => resolve());
});

// ── exit ──────────────────────────────────────────────────────────────────
// The pid file says "this process is alive" to every backend, so it goes
// last: removed inside process.exit (its `exit` listeners are the point of no
// return), or by the hard exit just before its self-SIGKILL — never earlier.
//
// On 2026-10-20 one agent logged "exiting", reached process.exit(0) and kept
// running (no error, its read loop still relaying) — with its socket and pid
// file already gone, so no backend could see or stop it. The cause did not
// reproduce, so the exit cannot depend on it: a stalled exit is ended here, and
// reported with what it takes to find the cause.

/** How long process.exit may take before the hard exit ends the process. */
const EXIT_GRACE_MS = 5_000;
// `sample` records for 1 s, then symbolicates.
const SAMPLE_TIMEOUT_MS = 5_000;
/** The shutdown step reached, for an `exit_stalled` report. */
let stage = "running";
let exitReason = "";

function shutdown(reason: string): void {
  if (closed) return;
  closed = true;
  exitReason = reason;
  setTimeout(() => hardExit("watchdog", reason), EXIT_GRACE_MS);
  stage = "log";
  log(`● exiting: ${reason}`);
  stage = "emit exited";
  emit({ kind: "agent", payload: { event: "exited", reason } });
  stage = "close socket";
  server.close();
  rmSync(socketPath, { force: true });
  stage = "close session";
  session.close();
  stage = "process.exit";
  // Typed `never`; on 2026-10-20 it returned.
  (process.exit as (code: number) => void)(0);
  hardExit("exit-returned", reason);
}
// A SIGTERM while exiting means the exit is taking too long: end it now. Not
// the default action — that would leave the CLI running, orphaned. (JS too
// stuck to run this is killed by the backend, CLI first.)
process.on("SIGTERM", () =>
  closed ? hardExit("sigterm", exitReason) : shutdown("SIGTERM"),
);
process.on("exit", removeExitFiles);

/**
 * What the agent leaves only while it lives: the named claude (left in place it
 * would pin a Claude version the updater has since deleted; the next start
 * makes it again, same name), then the pid file — last.
 */
function removeExitFiles(): void {
  if (options.namedClaudeBin) rmSync(options.namedClaudeBin, { force: true });
  rmSync(pidPath, { force: true });
}

/**
 * End a process whose exit stalled — loudly: capture what it was doing, write
 * an `exit_stalled` event (the backend reports it), then SIGKILL the CLI and
 * this process. Whatever the capture does, the kill runs.
 */
function hardExit(
  trigger: "exit-returned" | "watchdog" | "sigterm",
  reason: string,
): never {
  try {
    // A native stack sample of every thread, taken while still stalled.
    const samplePath = join(dir, `exit-stall-${Date.now()}.txt`);
    const sample = spawnSync(
      SAMPLE,
      [String(process.pid), "1", "-file", samplePath],
      { timeout: SAMPLE_TIMEOUT_MS, encoding: "utf8" },
    );
    const sampleError = sample.error
      ? sample.error.message
      : sample.status !== 0
        ? `sample exited ${String(sample.status ?? sample.signal)}: ${sample.stderr.trim()}`
        : null;
    const stalled = {
      event: "exit_stalled" as const,
      trigger,
      reason,
      stage,
      runtime: `bun ${process.versions.bun ?? "?"}`,
      cli: cli && {
        pid: cli.pid ?? null,
        exitCode: cli.exitCode,
        signalCode: cli.signalCode,
      },
      samplePath: sampleError ? null : samplePath,
      sampleError,
    };
    emit({ kind: "agent", payload: stalled });
    log(
      `● exit stalled (${trigger}, at ${stage}) — killing · ${sampleError ?? samplePath}`,
    );
  } finally {
    try {
      cli?.kill("SIGKILL");
      removeExitFiles();
    } finally {
      process.kill(process.pid, "SIGKILL");
    }
  }
  throw new Error("SIGKILL did not end the agent process");
}

await listening;
emit({
  kind: "agent",
  payload: {
    event: "started",
    pid: process.pid,
    resume: options.resume,
    resumeAt: options.resumeAt,
    fork: options.fork,
    account: args.account,
    turnIds: true,
  },
});
// The pid file is what says "running" to every backend counting agents; a
// crash leaves it behind, so readers check the pid is alive.
mkdirSync(dirname(pidPath), { recursive: true });
writeFileSync(pidPath, `${process.pid}\n`);
log(`● agent ${process.pid} · ${dir}`);
if (options.prompt !== null)
  pushInput(options.prompt.text, options.prompt.turnId);

for await (const msg of session) {
  // Nothing is numbered after `exited`.
  if (closed) break;
  if (msg.type === "stream_event") {
    const frame = partialFrameOf(msg);
    if (frame) pushFrame(frame);
    continue;
  }
  emit({ kind: "sdk", payload: msg });
  followCliQueue(msg);
  recordUsage(msg, Date.now());
  logMessage(msg);
  // A failed turn's message never lands in the transcript. A successful one
  // does, a few ms later: its text stays until the page sees it there.
  if (msg.type === "result" && msg.is_error) clearPartial();
}
shutdown("SDK stream ended");
