import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type {
  ConversationRuntime,
  RuntimeInfo,
  RuntimeSignal,
  TypedTurn,
} from "@plugins/conversations/server";
import { ContextUsageSchema } from "@plugins/conversations/core";
import type { LaunchFragment } from "@plugins/conversations/plugins/workspace/server";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
import type { EffortLevel } from "@plugins/conversations/plugins/effort-provider/core";
import { agentLaunchHooks } from "@plugins/conversations/plugins/agent-launch/server";
import { requireClaudeBin } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
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
import { agentDir, agentEventsPath, agentOptionsPath } from "./paths";
import {
  attachRunningAgents,
  forgetAgentProcess,
  killAgentProcess,
  startAgentProcess,
  type StartedAgent,
} from "./agent-process";
import { recountAgentProcesses } from "./agent-processes";
import {
  AgentNotRunningError,
  commandAgent,
  helloAgent,
} from "./socket-client";
import { watchPartialMessage } from "./partial-stream";

// The sdk runtime: one Agent SDK process per conversation (bin/agent.ts),
// started detached (agent-process.ts), so it outlives a backend restart.
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

function writeOptions(id: string, options: AgentLaunchOptions): void {
  mkdirSync(agentDir(id), { recursive: true });
  writeFileSync(agentOptionsPath(id), JSON.stringify(options, null, 2));
}

function readOptions(id: string): AgentLaunchOptions {
  return AgentLaunchOptionsSchema.parse(
    JSON.parse(readFileSync(agentOptionsPath(id), "utf8")),
  );
}

/**
 * Ask the agent to exit and wait for it to; kill it when it does not answer or
 * does not exit.
 */
async function stopAgent(id: string): Promise<void> {
  try {
    await commandAgent(id, { type: "shutdown" }, UnknownReplySchema);
  } catch (err) {
    if (!(err instanceof AgentNotRunningError)) throw err;
    // Not answering: gone, or wedged — either way nothing will exit by itself.
    await killAgentProcess(id);
    return;
  }
  try {
    await waitForProjection(
      id,
      (s) => s.agentPid === null,
      EXIT_TIMEOUT_MS,
      "exit after shutdown",
    );
  } catch (err) {
    if (!(err instanceof ProjectionTimeoutError)) throw err;
    await killAgentProcess(id);
    return;
  }
  await forgetAgentProcess(id);
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

/**
 * Wait until the agent answers on its socket. Each new event line (the
 * process's `started`) is the push to look again.
 */
async function waitForHello(
  id: string,
  signal: AbortSignal,
): Promise<"ready" | "timeout"> {
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
}

/** The agent process exited before it answered on its socket. */
class AgentStartError extends Error {
  constructor(
    readonly conversationId: string,
    readonly exitReason: string,
    readonly output: string,
  ) {
    super(
      `The agent process exited during startup (${exitReason})` +
        (output.trim() ? `: ${lastErrorLine(output)}` : " without any output"),
    );
    this.name = "AgentStartError";
  }
}

/**
 * The line that says what went wrong: Bun prints a crash as a code frame and
 * then `error: <message>`, so the last line naming an error, else the last line.
 */
function lastErrorLine(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const named = lines.findLast((l) => /^(\w*error\b|uncaught\b)/i.test(l));
  return named ?? lines.at(-1) ?? "";
}

/**
 * Hold the launch until the agent answers, so an agent that dies on start
 * fails it with its own output, rather than leaving the row `starting` for the
 * status sweep to call stuck. A slow start is not a failure: one still coming
 * up at the deadline is left to the readiness waiters, as before.
 */
async function awaitStart(id: string, started: StartedAgent): Promise<void> {
  const stopWaiting = new AbortController();
  const outcome = await Promise.race([
    waitForHello(id, stopWaiting.signal).then((r) => ({ kind: r })),
    started.exited.then((reason) => ({ kind: "exited" as const, reason })),
  ]);
  stopWaiting.abort();
  if (outcome.kind === "exited") {
    throw new AgentStartError(id, outcome.reason, started.output());
  }
}

async function sendTurn(id: string, text: string): Promise<TypedTurn> {
  await commandAgent(id, { type: "turn", turnId: null, text }, TurnReplySchema);
  // The agent queued it; the ledger confirms it on the `turn_started` event.
  return { verdict: { kind: "submitted" } };
}

export const sdkRuntime: ConversationRuntime = {
  id: "sdk",

  async list() {
    const live = await inspectAgents(await liveSdkConversationIds());
    // The reconciler's pass is also what notices an agent killed outright (its
    // pid file left behind, no watch event).
    recountAgentProcesses();
    return live;
  },

  inspect: inspectAgents,

  async subscribe(onSignal: (signal: RuntimeSignal) => void) {
    attachRunningAgents();
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
      appendSystemPrompt?: string;
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
      appendSystemPrompt: opts?.appendSystemPrompt,
    });
    const fresh = !eventsExist(id);
    await prepareAgentRow(id, cwd, !fresh, options.sessionId);
    if (fresh) forgetPosition(id);
    adoptAgent(id);
    writeOptions(id, options);
    await awaitStart(id, await startAgentProcess(id, options));
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
    // A turn the agent has begun answering (an assistant message or a tool result) stays.
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
    await startAgentProcess(id, relaunch);
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

  // Ready = the agent's socket answers: it queues turns from then on, so
  // nothing waits on the CLI's initialize.
  waitUntilReady: waitForHello,

  watchPartial: watchPartialMessage,

  async contextUsage(id: string) {
    try {
      // An agent started before the command existed keeps running until its
      // next relaunch; it simply cannot be asked.
      if (!(await helloAgent(id)).contextUsage)
        return { kind: "unavailable", reason: "unsupported" };
      const usage = await commandAgent(
        id,
        { type: "contextUsage" },
        ContextUsageSchema,
      );
      return { kind: "ready", usage };
    } catch (err) {
      if (err instanceof AgentNotRunningError)
        return { kind: "unavailable", reason: "not-running" };
      throw err;
    }
  },
};
