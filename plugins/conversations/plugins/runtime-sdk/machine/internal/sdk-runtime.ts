import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { z } from "zod";
import type {
  ConversationRuntime,
  RuntimeInfo,
  RuntimeSignal,
  TypedTurn,
} from "@plugins/conversations/server";
import type { LaunchFragment } from "@plugins/conversations/plugins/workspace/server";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
import type { EffortLevel } from "@plugins/conversations/plugins/effort-provider/core";
import {
  agentLaunchHooks,
  agentSessionArgs,
  agentSessionEnv,
} from "@plugins/conversations/plugins/agent-launch/server";
import { TMUX_HOSTED_BY_OPTION } from "@plugins/conversations/plugins/agent-launch/core";
import { recordPromptHookLaunch } from "@plugins/conversations/plugins/turn-ledger/server";
import { requireClaudeBin } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { backgroundPrefix } from "@plugins/packages/plugins/spawn-priority/server";
import {
  AgentLaunchOptionsSchema,
  DismissReplySchema,
  TurnReplySchema,
  type AgentLaunchOptions,
} from "../../core";
import {
  rewindRelaunchOptions,
  sdkLaunchOptions,
} from "../../server/internal/launch-options";
import {
  liveSdkConversationIds,
  prepareAgentRow,
  readAgentRow,
  readAgentRows,
  recordLaunchSession,
} from "../../server/internal/rows";
import {
  adoptAgent,
  catchUpNow,
  forgetPosition,
  ProjectionTimeoutError,
  startConsumer,
  waitForProjection,
} from "./consumer";
import {
  AGENT_SCRIPT,
  agentDir,
  agentEventsPath,
  agentOptionsPath,
  agentSocketPath,
  agentStderrPath,
} from "./paths";
import {
  AgentNotRunningError,
  commandAgent,
  helloAgent,
} from "./socket-client";
import { hasTmuxSession, tmux } from "./tmux";

// The sdk runtime: one Agent SDK process per conversation (bin/agent.ts),
// hosted in a tmux session named after the conversation — tmux supervises it
// and the terminal button shows its log (read-only), nothing types into it.
// Commands go over the agent's socket; everything it does comes back as lines
// of its events.jsonl, which the consumer applies to the conversation's
// `conversations_ext_sdk_agent` row. Liveness is "does the socket answer
// `hello`?"; status is that row.

// The agent answers `hello` within a second of starting; its CLI's initialize
// (readiness) takes a few more — far more under load, or on a cold cache.
const READY_TIMEOUT_MS = 60_000;
// Interrupt → the turn's `result`.
const INTERRUPT_SETTLE_MS = 30_000;
// `shutdown` → the agent's `exited`.
const EXIT_TIMEOUT_MS = 15_000;

const UnknownReplySchema = z.unknown();

/** Whether the agent answers on its socket. Any other failure throws (state unknown). */
async function answersHello(id: string): Promise<boolean> {
  try {
    await helloAgent(id);
    return true;
  } catch (err) {
    if (err instanceof AgentNotRunningError) return false;
    throw err;
  }
}

function eventsExist(id: string): boolean {
  const path = agentEventsPath(id);
  return [path, `${path}.1`, `${path}.2`, `${path}.3`].some((p) =>
    existsSync(p),
  );
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Start the agent process for `id` in a new tmux session, from the options
 * file already written in its directory. The session carries the
 * `@singularity-host sdk` option — set in the same tmux invocation — so a
 * backend still running the retired tmux runtime's pane listing never adopts
 * it as one of its own panes.
 */
async function startAgentSession(
  id: string,
  options: AgentLaunchOptions,
): Promise<void> {
  const command =
    backgroundPrefix() +
    // This backend's own bun, by path: the pane's PATH is the account's.
    [
      process.execPath,
      AGENT_SCRIPT,
      "--dir",
      agentDir(id),
      "--socket",
      agentSocketPath(id),
    ]
      .map(shellWord)
      .join(" ") +
    // stderr (the SDK's and the CLI's warnings, a crash before the first
    // event) is kept beside the events: the pane dies with the process.
    ` 2>>${shellWord(agentStderrPath(id))}`;
  const r = await tmux([
    "-u",
    "new-session",
    "-d",
    "-s",
    id,
    "-c",
    options.cwd,
    ...agentSessionArgs({
      env: agentSessionEnv(id),
      accountShell: userInfo().shell ?? "/bin/sh",
      claudeBin: options.claudeBin,
      command,
    }),
    ";",
    "set-option",
    "-t",
    id,
    TMUX_HOSTED_BY_OPTION,
    "sdk",
  ]);
  if (r.exitCode !== 0) {
    throw new Error(
      `tmux new-session for SDK agent ${id} failed (exit ${r.exitCode}): ${r.stderr.trim() || "<no stderr>"}`,
    );
  }
}

function writeOptions(id: string, options: AgentLaunchOptions): void {
  mkdirSync(agentDir(id), { recursive: true });
  writeFileSync(agentOptionsPath(id), JSON.stringify(options, null, 2));
}

function readOptions(id: string): AgentLaunchOptions {
  return AgentLaunchOptionsSchema.parse(
    JSON.parse(readFileSync(agentOptionsPath(id), "utf8")),
  );
}

/** Ask the agent to exit and wait for it to; then make sure its tmux session is gone. */
async function stopAgent(id: string): Promise<void> {
  let running = true;
  try {
    await commandAgent(id, { type: "shutdown" }, UnknownReplySchema);
  } catch (err) {
    if (!(err instanceof AgentNotRunningError)) throw err;
    running = false;
  }
  if (running) {
    await waitForProjection(
      id,
      (s) => s.agentPid === null,
      EXIT_TIMEOUT_MS,
      "exit after shutdown",
    );
  }
  // Idempotent: a session already gone is the goal.
  if (await hasTmuxSession(id)) await tmux(["kill-session", "-t", id]);
}

/** The live state of each of `ids` that is this DB's sdk conversation. */
async function inspectAgents(
  ids: readonly string[],
): Promise<Map<string, RuntimeInfo>> {
  const out = new Map<string, RuntimeInfo>();
  const mine = await liveSdkConversationIds(ids);
  if (mine.length === 0) return out;
  const [rows, alive] = await Promise.all([
    readAgentRows(mine),
    Promise.all(mine.map(answersHello)),
  ]);
  mine.forEach((id, i) => {
    const row = rows.get(id);
    if (!alive[i] || !row) return;
    out.set(id, {
      workingOn: row.working
        ? "turn"
        : row.backgroundTasks > 0
          ? "background"
          : null,
      dead: false,
      claudeSessionId: row.sessionId,
      statusWrittenAt: row.statusAt,
    });
  });
  return out;
}

async function sendTurn(id: string, text: string): Promise<TypedTurn> {
  await commandAgent(id, { type: "turn", turnId: null, text }, TurnReplySchema);
  // The agent queued it; the ledger confirms it on the `turn_started` event.
  return { verdict: { kind: "submitted" } };
}

export const sdkRuntime: ConversationRuntime = {
  id: "sdk",

  async list() {
    return inspectAgents(await liveSdkConversationIds());
  },

  inspect: inspectAgents,

  async subscribe(onSignal: (signal: RuntimeSignal) => void) {
    const stop = await startConsumer(onSignal);
    return () => void stop();
  },

  async isRunning(id: string) {
    return answersHello(id);
  },

  async create(
    id: string,
    cwd: string,
    launch: LaunchFragment,
    opts?: {
      prompt?: string;
      model?: ConversationModel;
      effort?: EffortLevel;
      resumeSessionId?: string;
      forkSession?: boolean;
    },
  ): Promise<void> {
    // Idempotent under durable-job retry: a live agent already took the launch.
    if (await this.isRunning(id)) return;
    // A missing CLI throws HERE (ClaudeCodeUnavailableError) rather than
    // starting an agent that dies on spawn.
    const claudeBin = requireClaudeBin();
    const options = sdkLaunchOptions({
      cwd,
      claudeBin,
      launch,
      hooks: agentLaunchHooks(),
      model: opts?.model,
      effort: opts?.effort,
      resumeSessionId: opts?.resumeSessionId,
      forkSession: opts?.forkSession,
      prompt: opts?.prompt,
    });
    const fresh = !eventsExist(id);
    await prepareAgentRow(id, cwd, !fresh, options.sessionId);
    if (fresh) forgetPosition(id);
    adoptAgent(id);
    // A dead agent's tmux session (its pane kept by nothing) is cleared first:
    // tmux refuses a duplicate session name.
    if (await hasTmuxSession(id)) await tmux(["kill-session", "-t", id]);
    writeOptions(id, options);
    await startAgentSession(id, options);
    // The agent's `turn_started` event confirms every turn it takes, so the
    // ledger must not treat this conversation as hookless.
    await recordPromptHookLaunch(id);
  },

  async delete(id: string) {
    await stopAgent(id);
  },

  send: sendTurn,

  async interrupt(id: string) {
    await commandAgent(id, { type: "interrupt" }, UnknownReplySchema);
  },

  async stop(id: string) {
    await catchUpNow(id);
    const before = await readAgentRow(id);
    if (!before?.working) return { returnedText: null };
    const interruptedAt = before.cursorSeq;
    await commandAgent(id, { type: "interrupt" }, UnknownReplySchema);
    const settled = await waitForProjection(
      id,
      (s) => s.cursorSeq > interruptedAt && !s.working,
      INTERRUPT_SETTLE_MS,
      "the interrupted turn's result",
    );
    // The same rule as tmux's transcript rewind: a turn the agent has begun
    // answering (an assistant message or a tool result) stays.
    if (settled.turnReplied || !settled.lastPromptUuid) {
      return { returnedText: null };
    }
    if (!settled.sessionId) {
      throw new Error(
        `SDK agent ${id}: cannot take the stopped turn back — no session id yet`,
      );
    }
    const relaunch = rewindRelaunchOptions(readOptions(id), {
      sessionId: settled.sessionId,
      anchorUuid: settled.rewindAnchorUuid,
      promptUuid: settled.lastPromptUuid,
    });
    await stopAgent(id);
    writeOptions(id, relaunch);
    await recordLaunchSession(id, relaunch.sessionId);
    await startAgentSession(id, relaunch);
    await waitForProjection(
      id,
      (s) => s.agentPid !== null,
      READY_TIMEOUT_MS,
      "restart after the rewind",
    );
    return { returnedText: settled.lastPromptText };
  },

  async answerPrompt(id: string, text: string) {
    // Withdraw every question the agent holds (denied, the turn interrupted),
    // then the text goes as a normal turn.
    const hello = await helloAgent(id);
    for (const request of hello.openRequests) {
      await commandAgent(
        id,
        { type: "dismiss", requestId: request.requestId },
        DismissReplySchema,
      );
    }
    return sendTurn(id, text);
  },

  async waitUntilReady(id: string, signal: AbortSignal) {
    // Ready = the agent's socket answers: it queues turns from then on, so
    // nothing waits on the CLI's initialize. Until then, each new event line
    // (the process's `started`) is the push to look again.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!signal.aborted && Date.now() < deadline) {
      const seen = (await readAgentRow(id))?.cursorSeq ?? 0;
      if (await answersHello(id)) return "ready";
      try {
        await waitForProjection(
          id,
          (s) => s.cursorSeq > seen,
          Math.max(1, deadline - Date.now()),
          "the agent's start",
        );
      } catch (err) {
        if (err instanceof ProjectionTimeoutError) return "timeout";
        throw err;
      }
    }
    return "timeout";
  },
};
