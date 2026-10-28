import { z } from "zod";
import type {
  ConversationRuntime,
  OutgoingTurn,
  RuntimeInfo,
  RuntimeInspection,
  RuntimeSignal,
} from "@plugins/conversations/server";
import { ContextUsageSchema } from "@plugins/conversations/core";
import type { LaunchFragment } from "@plugins/conversations/plugins/workspace/server";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
import type { EffortLevel } from "@plugins/conversations/plugins/effort-provider/core";
import { agentLaunchPolicy } from "@plugins/conversations/plugins/agent-launch/server";
import { compactionHookEntry } from "@plugins/conversations/plugins/compaction-context/machine";
import { stopGateHookEntry } from "@plugins/conversations/plugins/stop-gate/machine";
import { requireClaudeBin } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import {
  type AgentLaunchOptions,
  DismissReplySchema,
  type HelloReply,
  TurnReplySchema,
  USAGE_LIMIT_ERROR,
} from "../../core";
import {
  continueRelaunchOptions,
  rewindRelaunchOptions,
  sdkLaunchOptions,
} from "../../server/internal/launch-options";
import {
  prepareAgentRow,
  readAgentRow,
  readAgentRows,
  recordLaunchSession,
} from "../../server/internal/rows";
import { runningAgentIds } from "./agent-processes";
import {
  adoptAgent,
  catchUpNow,
  catchUpWithin,
  forgetPosition,
  onEventsAppended,
  ProjectionTimeoutError,
  ProjectionWaitAbortedError,
  startConsumer,
  waitForProjection,
} from "./consumer";
import { agentEventsExist } from "./paths";
import {
  attachRunningAgents,
  awaitAgentExit,
  forgetAgentProcess,
  killAgentProcess,
  nextLaunchAccount,
  readAgentOptions,
  startAgentProcess,
} from "./agent-process";
import { recountAgentProcesses } from "./agent-processes";
import {
  AgentNotRunningError,
  AgentUnresponsiveError,
  commandAgent,
  helloAgent,
} from "./socket-client";
import { watchPartialMessage } from "./partial-stream";
import { startOutcome, type StartOutcome } from "./start-outcome";

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
// `shutdown` → the agent process gone. Above the agent's own hard exit (5 s),
// so a kill here means even that did not run.
const EXIT_TIMEOUT_MS = 15_000;

// How long an inspect lets a projection behind the agent's head catch up
// before calling that conversation's state unverified.
const INSPECT_CATCH_UP_MS = 5_000;
// How long a launch lets a catch-up the agent's first appends woke settle
// before calling the consumer stalled — instead of sitting out
// READY_TIMEOUT_MS beside an agent that is up.
const LAUNCH_CATCH_UP_MS = 10_000;

const UnknownReplySchema = z.unknown();

/** The agent's `hello`, or `not-running`. Any other failure throws (state unknown). */
async function helloOf(id: string): Promise<HelloReply | "not-running"> {
  try {
    return await helloAgent(id);
  } catch (err) {
    if (err instanceof AgentNotRunningError) return "not-running";
    throw err;
  }
}

/** Whether the agent answers on its socket. Any other failure throws (state unknown). */
async function answersHello(id: string): Promise<boolean> {
  return (await helloOf(id)) !== "not-running";
}

/**
 * Ask the agent to exit and wait for the process to be gone; kill it when it
 * is not — and report the kill, which the agent's own exit should have made
 * unnecessary.
 */
async function stopAgent(id: string): Promise<void> {
  try {
    await commandAgent(id, { type: "shutdown" }, UnknownReplySchema);
  } catch (err) {
    // No socket (gone, or already exiting) or no reply (exiting, or wedged):
    // the wait below tells them apart.
    if (
      !(err instanceof AgentNotRunningError) &&
      !(err instanceof AgentUnresponsiveError)
    )
      throw err;
  }
  // Waits for the process, not its `exited` line: the agent writes that before
  // it exits — and on 2026-10-20 one never did.
  if ((await awaitAgentExit(id, EXIT_TIMEOUT_MS)) === "timeout") {
    await reportKill(
      id,
      await killAgentProcess(id),
      `it was still running ${String(EXIT_TIMEOUT_MS / 1000)} s after being told to stop`,
    );
    return;
  }
  await forgetAgentProcess(id);
}

async function reportKill(
  id: string,
  pid: number | null,
  why: string,
): Promise<void> {
  // Nothing alive: it was already gone, the normal case for "not answering".
  if (pid === null) return;
  await recordReport({
    kind: "crash",
    source: "server-caught",
    message: `SDK agent ${id}: stopping it took a SIGKILL of pid ${String(pid)} and its CLI — ${why}. Its own exit (shutdown, then the hard exit) should have ended it; its agent.log may say where it stopped`,
    data: { errorType: "SdkAgentKilled", label: "runtime-sdk.exit" },
  });
}

type AgentRow = NonNullable<Awaited<ReturnType<typeof readAgentRow>>>;

function infoOf(row: AgentRow): RuntimeInfo {
  return {
    workingOn: row.working
      ? "turn"
      : row.backgroundTasks > 0
        ? "background"
        : null,
    dead: false,
    claudeSessionId: row.sessionId,
    statusWrittenAt: row.statusAt,
  };
}

/**
 * The live state of each of `ids` that is this DB's sdk conversation — read
 * at the agent's own head, or not at all. The projection is checked against
 * the seq the agent answers `hello` with; one behind it gets a bounded
 * catch-up, and one still behind after it is `unverified`: this backend is
 * not applying the agent's events (2026-10-25: a stalled consumer showed
 * `waiting` beside an agent running a build), so its row says nothing current.
 */
async function inspectAgents(
  ids: readonly string[],
): Promise<Map<string, RuntimeInspection>> {
  const out = new Map<string, RuntimeInspection>();
  const mine = await runningAgentIds(ids);
  if (mine.length === 0) return out;
  // Hello first, the rows after: a row read before the agent answered could
  // lag it by the lines written in between, and look behind when it is not.
  const hellos = await Promise.all(
    mine.map(async (id) => ({ id, hello: await helloOf(id) })),
  );
  const rows = await readAgentRows(mine);
  const inspected = await Promise.all(
    hellos.map(async ({ id, hello }) => ({
      id,
      inspection: await inspectAgent(id, rows.get(id), hello),
    })),
  );
  for (const { id, inspection } of inspected) {
    if (inspection) out.set(id, inspection);
  }
  return out;
}

async function inspectAgent(
  id: string,
  row: AgentRow | undefined,
  hello: HelloReply | "not-running",
): Promise<RuntimeInspection | null> {
  if (hello === "not-running" || !row) return null;
  if (row.cursorSeq >= hello.seq) return { kind: "live", info: infoOf(row) };
  const behind = (cursorSeq: number): RuntimeInspection => ({
    kind: "unverified",
    reason: `the agent is at event ${String(hello.seq)}, but this backend has applied only up to ${String(cursorSeq)}`,
  });
  if ((await catchUpWithin(id, INSPECT_CATCH_UP_MS)) === "overdue")
    return behind(row.cursorSeq);
  const caughtUp = await readAgentRow(id);
  if (!caughtUp) return null;
  return caughtUp.cursorSeq >= hello.seq
    ? { kind: "live", info: infoOf(caughtUp) }
    : behind(caughtUp.cursorSeq);
}

/**
 * Wait for the consumer to apply the agent's `started` line — the push that
 * the agent is up — then ask it `hello` once. `launchedAt` is when this launch
 * began: a projection still showing a predecessor's pid (its `exited` line not
 * applied yet) is not this start. Null when no launch is in hand (the readiness
 * waiters): any started agent counts.
 *
 * Every outcome is decided by one `hello` at the end, never by the projection
 * alone: on 2026-10-25 a stalled consumer never applied `started`, and the old
 * wait — which asked `hello` again only when the projection moved — sat out
 * its whole bound beside an agent that had answered all along. And the wait
 * itself ends early when catch-up is wedged: each append the watch hears gets
 * a bounded catch-up ({@link LAUNCH_CATCH_UP_MS}); one that does not settle
 * ends the wait, and the `hello` names the consumer behind.
 */
async function waitForStart(
  id: string,
  signal: AbortSignal,
  launchedAt: Date | null,
): Promise<StartOutcome> {
  // The probe: every append the agent makes (heard straight from the watch)
  // gets a bounded catch-up. One that does not settle means this backend is
  // not applying the agent's events — the wait stops there, in seconds, rather
  // than sitting out READY_TIMEOUT_MS. A push per append, never a poll.
  const wait = new AbortController();
  const callOff = () => wait.abort();
  if (signal.aborted) wait.abort();
  signal.addEventListener("abort", callOff);
  let stalled = false;
  let probeError: Error | null = null;
  let probing = false;
  const stopProbing = onEventsAppended(id, () => {
    if (probing) return;
    probing = true;
    void catchUpWithin(id, LAUNCH_CATCH_UP_MS).then(
      (r) => {
        probing = false;
        if (r === "overdue") {
          stalled = true;
          wait.abort();
        }
      },
      (err: unknown) => {
        probeError = err instanceof Error ? err : new Error(String(err));
        wait.abort();
      },
    );
  });
  let applied: boolean;
  try {
    await waitForProjection(
      id,
      (s) =>
        s.agentPid !== null &&
        (launchedAt === null ||
          (s.statusAt !== null && s.statusAt >= launchedAt)),
      READY_TIMEOUT_MS,
      "the agent's start",
      wait.signal,
    );
    applied = true;
  } catch (err) {
    if (!(err instanceof ProjectionWaitAbortedError)) {
      if (!(err instanceof ProjectionTimeoutError)) throw err;
      applied = false;
    } else if (probeError !== null) {
      throw probeError;
    } else if (stalled) {
      applied = false;
    } else {
      return { kind: "slow" };
    }
  } finally {
    stopProbing();
    signal.removeEventListener("abort", callOff);
  }
  let agentSeq: number | null;
  try {
    agentSeq = (await helloAgent(id)).seq;
  } catch (err) {
    if (!(err instanceof AgentNotRunningError)) throw err;
    agentSeq = null;
  }
  const cursorSeq = (await readAgentRow(id))?.cursorSeq ?? 0;
  const outcome = startOutcome({ applied, agentSeq, cursorSeq });
  if (outcome.kind === "consumer-behind") {
    await recordReport({
      kind: "sdk-consumer-stalled",
      source: "server-caught",
      message: `SDK agent ${id}: it answers at seq ${String(outcome.agentSeq)}, but its row has applied only up to seq ${String(outcome.cursorSeq)} — this backend is not applying its events`,
      data: {
        conversationId: id,
        cursorSeq: outcome.cursorSeq,
        agentSeq: outcome.agentSeq,
      },
    });
  }
  return outcome;
}

/**
 * Ready = the agent's socket answers: it queues turns from then on, so nothing
 * waits on the CLI's initialize. A consumer behind the agent is reported (by
 * {@link waitForStart}) and still ready — the agent takes the turn.
 */
async function waitUntilReady(
  id: string,
  signal: AbortSignal,
): Promise<"ready" | "timeout"> {
  const outcome = await waitForStart(id, signal, null);
  return outcome.kind === "slow" ? "timeout" : "ready";
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
 * Start the agent and hold the launch until it is up, so an agent that dies on
 * start fails it with its own output, rather than leaving the row `starting`
 * for the status sweep to call stuck. A slow start is not a failure: one still
 * coming up at the deadline is left to the readiness waiters, as before. Nor is
 * a consumer behind the agent (reported by {@link waitForStart}): the agent is
 * up and took the launch prompt, and failing the launch would hand the turn
 * back to be sent a second time.
 */
async function launchAgent(
  id: string,
  options: AgentLaunchOptions,
): Promise<void> {
  const launchedAt = new Date();
  const started = await startAgentProcess(id, options);
  const stopWaiting = new AbortController();
  const outcome = await Promise.race([
    waitForStart(id, stopWaiting.signal, launchedAt),
    started.exited.then((reason) => ({ kind: "exited" as const, reason })),
  ]);
  stopWaiting.abort();
  if (outcome.kind === "exited") {
    throw new AgentStartError(id, outcome.reason, started.output());
  }
}

/**
 * An agent whose last turn stopped at its account's usage limit keeps that
 * account until its process restarts (the launch picks the account). So before
 * a turn reaches it, restart it on the session's end when a launch now would
 * pick another account — every turn (typed, Resume, Resume all) carries on
 * where an account with room is. When none has room, the turn goes to the
 * agent as is and the CLI answers with its limit notice again. Any other API
 * error (a server error, a lost connection) is not the account's: the turn
 * goes to the same agent.
 */
async function moveOffSpentAccount(id: string): Promise<void> {
  await catchUpNow(id);
  const row = await readAgentRow(id);
  if (row?.stopError !== USAGE_LIMIT_ERROR || !row.sessionId || row.working)
    return;
  if (nextLaunchAccount() === row.account) return;
  const relaunch = continueRelaunchOptions(readAgentOptions(id), row.sessionId);
  await stopAgent(id);
  await recordLaunchSession(id, relaunch.sessionId);
  await launchAgent(id, relaunch);
}

async function sendTurn(id: string, turn: OutgoingTurn): Promise<void> {
  await moveOffSpentAccount(id);
  await commandAgent(
    id,
    { type: "turn", turnId: turn.turnId, text: turn.text },
    TurnReplySchema,
  );
  // The agent queued it; the ledger confirms it on the `turn_started` event.
}

export const sdkRuntime: ConversationRuntime = {
  id: "sdk",

  async list() {
    const live = await inspectAgents(await runningAgentIds());
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
      prompt?: OutgoingTurn;
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
      policy: agentLaunchPolicy({
        compaction: compactionHookEntry(),
        stopGate: stopGateHookEntry(),
      }),
      model: opts?.model,
      effort: opts?.effort,
      resumeSessionId: opts?.resumeSessionId,
      forkSession: opts?.forkSession,
      prompt: opts?.prompt,
      appendSystemPrompt: opts?.appendSystemPrompt,
    });
    const fresh = !agentEventsExist(id);
    await prepareAgentRow(id, cwd, !fresh, options.sessionId);
    if (fresh) forgetPosition(id);
    adoptAgent(id);
    await launchAgent(id, options);
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
    if (!before?.working) return { returnedPromptUuid: null };
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
      return { returnedPromptUuid: null };
    }
    if (!settled.sessionId) {
      throw new Error(
        `SDK agent ${id}: cannot take the stopped turn back — no session id yet`,
      );
    }
    const relaunch = rewindRelaunchOptions(readAgentOptions(id), {
      sessionId: settled.sessionId,
      anchorUuid: settled.rewindAnchorUuid,
      promptUuid: settled.lastPromptUuid,
    });
    await stopAgent(id);
    await recordLaunchSession(id, relaunch.sessionId);
    // The same launch wait as every start: a projection still showing the
    // predecessor's pid (its `exited` line not applied yet) is not this start.
    await launchAgent(id, relaunch);
    return { returnedPromptUuid: settled.lastPromptUuid };
  },

  async answerPrompt(id: string, turn: OutgoingTurn) {
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
    await sendTurn(id, turn);
  },

  waitUntilReady,

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
