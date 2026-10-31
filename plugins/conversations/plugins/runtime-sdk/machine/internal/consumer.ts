import { mkdirSync } from "node:fs";
import { relative, sep } from "node:path";
import type { RuntimeSignal } from "@plugins/conversations/server";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import { createKeyedCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { withDeadline } from "@plugins/packages/plugins/deadline/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import {
  confirmTurn,
  dropTypedTurns,
  resolvePromptSubmit,
} from "@plugins/conversations/plugins/turn-ledger/server";
import {
  onQuestionResolved,
  type ResolvedQuestion,
} from "@plugins/conversations/plugins/question-relay/server";
import {
  holdQuestion,
  retireQuestion,
} from "@plugins/conversations/plugins/question-relay/machine";
import {
  AGENT_EVENTS_FILE,
  DismissReplySchema,
  USAGE_LIMIT_ERROR,
  type OpenRequest,
} from "../../core";
import {
  reduceEvents,
  type AgentEffect,
  type AgentProjection,
} from "../../server/internal/reducer";
import {
  isSdkConversation,
  liveSdkConversationIds,
  readAgentRow,
  writeProjection,
} from "../../server/internal/rows";
import { requestAutoResume } from "./auto-resume";
import { readEventsAfter } from "./event-reader";
import type { ReadPosition } from "../../server/internal/read-position";
import { runningAgentIds } from "./agent-processes";
import { agentReady } from "./partial-stream";
import { agentEventsExist, agentEventsPath, ownAgentsRoot } from "./paths";
import {
  AgentNotRunningError,
  commandAgent,
  helloAgent,
} from "./socket-client";
import { z } from "zod";

// Events → state: tails every SDK agent's events.jsonl from the cursor its
// conversation row holds, applies the new lines (reducer.ts), runs their side
// effects (the turn ledger, the question relay) and signals the status
// reconciler. Push-based end to end: one kqueue watch over the agents'
// directory (fs.watch never reports appends under bun), one catch-up per
// conversation at a time (a keyed coalescer folds a burst into one trailing
// run), and in-process waiters for the runtime's own "wait until the agent
// did X" (stop, ready).

/**
 * The one watch over this namespace's `state/sdk-agents/<ns>/`: an append to any agent's events file
 * wakes that conversation's catch-up. kqueue (`writesWhileOpen`) because
 * FSEvents coalesces appends to an open file; the directory holds a handful of
 * files per agent and is reclaimed after 14 days, far under the entry ceiling.
 */
export const sdkEventsWatcher = defineFileWatcher({
  name: "runtime-sdk.events",
  description:
    "Notices an SDK agent appending to its events.jsonl, so this backend applies the new lines to the conversation's status, turns and questions.",
  writesWhileOpen: true,
  debounceMs: 10,
});

/**
 * Where each agent's file was last read up to by THIS process. A restart starts
 * from the position stored with the cursor (`eventsPosition`).
 */
const positions = new Map<string, ReadPosition | null>();

/**
 * Conversation ids known to be this DB's sdk rows. Only a yes is kept: a cached
 * no would skip that conversation's events forever, silently — the same shape
 * as the 2026-10-25 stall — and asking again is one indexed lookup per watched
 * batch.
 */
const ours = new Set<string>();

type Waiter = {
  until: (s: AgentProjection) => boolean;
  resolve: (s: AgentProjection) => void;
};
const waiters = new Map<string, Set<Waiter>>();

let signal: ((s: RuntimeSignal) => void) | null = null;

/** Mark `id` as this DB's sdk conversation (its `create` just ran here). */
export function adoptAgent(id: string): void {
  ours.add(id);
}

async function isOurs(id: string): Promise<boolean> {
  if (ours.has(id)) return true;
  const mine = await isSdkConversation(id);
  if (mine) ours.add(id);
  return mine;
}

/** {@link waitForProjection}'s bound ran out. */
export class ProjectionTimeoutError extends Error {
  constructor(id: string, what: string, timeoutMs: number) {
    super(`SDK agent ${id}: ${what} did not happen within ${timeoutMs}ms`);
    this.name = "ProjectionTimeoutError";
  }
}

/** {@link waitForProjection}'s caller stopped waiting (its signal aborted). */
export class ProjectionWaitAbortedError extends Error {
  constructor(id: string, what: string) {
    super(`SDK agent ${id}: stopped waiting for ${what}`);
    this.name = "ProjectionWaitAbortedError";
  }
}

/**
 * Wait until the conversation's applied projection satisfies `until` — checked
 * against the stored row first, then after every catch-up. Resolves the
 * projection; rejects after `timeoutMs`, or once `signal` aborts.
 */
export async function waitForProjection(
  id: string,
  until: (s: AgentProjection) => boolean,
  timeoutMs: number,
  what: string,
  signal?: AbortSignal,
): Promise<AgentProjection> {
  let resolve!: (s: AgentProjection) => void;
  let reject!: (e: Error) => void;
  const done = new Promise<AgentProjection>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const waiter: Waiter = { until, resolve };
  const set = waiters.get(id) ?? new Set();
  waiters.set(id, set);
  set.add(waiter);
  const timer = setTimeout(
    () => reject(new ProjectionTimeoutError(id, what, timeoutMs)),
    timeoutMs,
  );
  const onAbort = () => reject(new ProjectionWaitAbortedError(id, what));
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort);
  try {
    // Registered before the read, so a catch-up landing in between wakes it.
    const current = await readAgentRow(id);
    if (current && until(current)) return current;
    // Lines may already be on disk that no watch event announced yet.
    catchUps.trigger(id);
    return await done;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    set.delete(waiter);
    if (set.size === 0) waiters.delete(id);
  }
}

const catchUps = createKeyedCoalescer<string>({
  run: (id) => watchedCatchUp(id),
});

// A catch-up reads a row, runs a few idempotent effects and writes the row:
// milliseconds, a few seconds on a loaded host. Far past that, it is parked on
// something that will not settle — and since catch-ups run one at a time per
// conversation, every later event of that conversation waits behind it.
const CATCH_UP_DEADLINE_MS = 30_000;

/** Where a catch-up run is: set before each of its awaits, named by the overdue report. */
type CatchUpProgress = { stage: string };

class CatchUpOverdueError extends Error {
  constructor(id: string) {
    super(`SDK agent ${id}: catch-up overdue`);
    this.name = "CatchUpOverdueError";
  }
}

/**
 * One catch-up run, watched: past {@link CATCH_UP_DEADLINE_MS} it files an
 * `sdk-catch-up-overdue` report naming the step it is parked in (once per run)
 * and keeps waiting. Nothing cancels it — an effect cannot be aborted halfway,
 * and the coalescer's slot must stay held until the run really settles. On
 * 2026-10-25 a run that never settled stalled one conversation's events for a
 * backend's whole lifetime, with nothing filed.
 */
async function watchedCatchUp(id: string): Promise<void> {
  const progress: CatchUpProgress = { stage: "start" };
  const startedAt = Date.now();
  const work = runTracked("runtime-sdk:catch-up", () => catchUp(id, progress));
  try {
    await withDeadline(
      work,
      CATCH_UP_DEADLINE_MS,
      () => new CatchUpOverdueError(id),
    );
  } catch (err) {
    if (!(err instanceof CatchUpOverdueError)) throw err;
    await recordReport({
      kind: "sdk-catch-up-overdue",
      source: "server-caught",
      message: `SDK agent ${id}: a catch-up of its events has been running for ${String(Math.round((Date.now() - startedAt) / 1000))} s, parked at "${progress.stage}"; the conversation's later events wait behind it`,
      data: {
        conversationId: id,
        stage: progress.stage,
        elapsedMs: Date.now() - startedAt,
      },
    });
    await work;
  }
}

/** Apply every line of `id`'s events file past its cursor. */
async function catchUp(id: string, progress: CatchUpProgress): Promise<void> {
  progress.stage = "read-row";
  const row = await readAgentRow(id);
  if (!row) {
    // No row and no events: `create` has not prepared the row yet (it does
    // before the agent starts). Events with no row are an agent this backend
    // cannot apply — say so, rather than skip them forever.
    if (!agentEventsExist(id)) return;
    progress.stage = "report";
    await recordReport({
      kind: "crash",
      source: "server-caught",
      message: `SDK agent ${id}: its events file ${agentEventsPath(id)} exists but the conversation has no conversations_ext_sdk_agent row, so its events are not applied`,
      data: { errorType: "SdkEventsWithoutRow", label: "runtime-sdk.events" },
    });
    return;
  }
  const path = agentEventsPath(id);
  const { worktreePath: _path, eventsPosition, ...projection } = row;
  // Where this process last stopped, else — the first catch-up since a
  // restart — the position stored with the cursor: a restart reads what was
  // appended while no backend ran, not every generation of the agent's
  // history (hundreds of MB across the live agents, parsed on every boot).
  const from = positions.has(id) ? (positions.get(id) ?? null) : eventsPosition;
  const read = readEventsAfter(path, projection.cursorSeq, from);
  const { state, effects, gaps, malformed, stalls } = reduceEvents(
    projection,
    read.events,
  );
  progress.stage = "report";
  for (const gap of gaps) {
    await recordReport({
      kind: "crash",
      source: "server-caught",
      message: `SDK agent ${id}: events ${gap.from}–${gap.to} were rotated out of ${path} before this backend read them; the conversation's status may have missed them`,
      data: { errorType: "SdkEventGap", label: "runtime-sdk.events" },
    });
  }
  for (const bad of malformed) {
    await recordReport({
      kind: "crash",
      source: "server-caught",
      message: `SDK agent ${id}: event ${bad.seq} (system/${bad.subtype}) in ${path} did not parse, so it was skipped; the conversation's status may be wrong until a later event corrects it — ${bad.issue}`,
      data: { errorType: "SdkMalformedEvent", label: "runtime-sdk.events" },
    });
  }
  for (const stall of stalls) {
    // Everything goes in the message: the crash kind's payload keeps only its
    // own fields.
    const why = {
      "exit-returned": "process.exit returned",
      watchdog: "it was still running after the grace period",
      sigterm: "a SIGTERM arrived before it was gone",
    }[stall.trigger];
    const cli = stall.cli
      ? `CLI pid ${String(stall.cli.pid)} (exit ${String(stall.cli.exitCode)}, signal ${String(stall.cli.signalCode)})`
      : "no CLI spawned";
    const sample = stall.samplePath
      ? `native stack sample: ${stall.samplePath}`
      : `no stack sample: ${stall.sampleError ?? "no reason given"}`;
    await recordReport({
      kind: "crash",
      source: "server-caught",
      message: `SDK agent ${id}: its exit stalled after "${stall.reason}" — ${why}, at step "${stall.stage}" (${stall.runtime}; ${cli}) — so it SIGKILLed its CLI and itself; ${sample}`,
      data: { errorType: "SdkAgentExitStalled", label: "runtime-sdk.exit" },
    });
  }
  // Side effects first, then the cursor: a crash in between replays the lines,
  // and every effect is idempotent (a prompt resolves once, a question
  // registration is an upsert).
  for (const effect of effects) {
    progress.stage = `effect:${effect.kind}`;
    await runEffect(id, effect);
  }
  progress.stage = "write-projection";
  // Also when only the position moved: an idle agent's first read after this
  // column existed stores where its history ends, else every boot would read
  // it all again until its next line.
  if (
    state.cursorSeq !== row.cursorSeq ||
    !samePosition(read.position, eventsPosition)
  )
    await writeProjection(id, state, read.position);
  // A usage limit stopped it (written first: the job reads the row).
  if (
    state.stopError === USAGE_LIMIT_ERROR &&
    state.stoppedAt !== null &&
    state.stoppedAt.getTime() !== projection.stoppedAt?.getTime()
  )
    await requestAutoResume();
  progress.stage = "signal";
  positions.set(id, read.position);
  if (read.events.length === 0) return;
  // A (re)started agent takes `subscribe` now: a watched partial reconnects.
  if (
    read.events.some((e) => e.kind === "agent" && e.payload.event === "ready")
  )
    agentReady(id);
  signal?.({ conversationIds: [id] });
  for (const w of [...(waiters.get(id) ?? [])]) {
    if (w.until(state)) w.resolve(state);
  }
}

function samePosition(a: ReadPosition | null, b: ReadPosition | null): boolean {
  return a?.ino === b?.ino && a?.offset === b?.offset;
}

const QuestionInputSchema = z.object({ questions: z.unknown() });

async function runEffect(id: string, effect: AgentEffect): Promise<void> {
  switch (effect.kind) {
    case "prompt-submitted": {
      const outcome = await confirmTurn(
        id,
        effect.turnId,
        effect.promptUuid,
        effect.at,
      );
      if (
        outcome.kind === "unknown-turn" ||
        outcome.kind === "other-conversation"
      ) {
        const owner =
          outcome.kind === "other-conversation" ? outcome.owner : null;
        await recordReport({
          kind: "turn-unknown-id",
          source: "server-caught",
          message: `SDK agent ${id}: it took turn ${effect.turnId}, which ${owner === null ? "no ledger row has" : `is conversation ${owner}'s`}, so no turn was confirmed`,
          data: {
            conversationId: id,
            turnId: effect.turnId,
            promptUuid: effect.promptUuid,
            owner,
          },
        });
      }
      return;
    }
    case "prompt-submitted-by-text":
      // TEMPORARY: an agent started before turn ids (its launch prompt),
      // matched by equal text. Deleted once no such agent runs.
      await resolvePromptSubmit(id, effect.text, effect.promptUuid, effect.at);
      return;
    case "turn-without-id":
      await recordReport({
        kind: "turn-without-id",
        source: "server-caught",
        message: `SDK agent ${id}: it took a turn with no turn id (event ${String(effect.seq)}), though it puts one on every turn it is sent; no turn was confirmed`,
        data: {
          conversationId: id,
          seq: effect.seq,
          promptUuid: effect.promptUuid,
          text: effect.text,
        },
      });
      return;
    case "turns-dropped":
      await dropTypedTurns(id, effect.at);
      return;
    case "question":
      if (effect.pid === null) {
        throw new Error(
          `SDK agent ${id}: a question arrived before the agent's start event`,
        );
      }
      await syncOpenRequest(id, effect.request, effect.pid);
      return;
    case "question-closed":
      await retireQuestion(id, effect.toolUseId);
      return;
  }
}

/**
 * Hold an open request's question for the web form, and hand the agent any
 * resolution it already has (a backend that was down when it was answered).
 */
async function syncOpenRequest(
  id: string,
  request: OpenRequest,
  pid: number,
): Promise<void> {
  const resolution = await holdQuestion(id, {
    toolUseId: request.toolUseId,
    questions: QuestionInputSchema.parse(request.input).questions,
    pid,
  });
  if (resolution.state === "open") return;
  await deliver(id, request.requestId, resolution);
}

async function deliver(
  id: string,
  requestId: string,
  resolution: ResolvedQuestion["resolution"],
): Promise<void> {
  try {
    if (resolution.state === "answered") {
      await commandAgent(
        id,
        { type: "answer", requestId, answer: resolution.answer },
        z.unknown(),
      );
    } else {
      // Released ("answer in terminal" — there is no terminal to answer in) or
      // abandoned: the question stops waiting.
      await commandAgent(
        id,
        { type: "dismiss", requestId },
        DismissReplySchema,
      );
    }
  } catch (err) {
    // The agent died with the question open: nothing is waiting for it.
    if (err instanceof AgentNotRunningError) return;
    throw err;
  }
}

/** The web answered (or released) a question this backend's agent holds. */
async function onResolved(q: ResolvedQuestion): Promise<void> {
  if (!(await isOurs(q.conversationId))) return;
  const row = await readAgentRow(q.conversationId);
  if (!row || row.openToolUseId !== q.toolUseId || !row.openRequestId) return;
  await deliver(q.conversationId, row.openRequestId, q.resolution);
}

/** The id of the agent directory a watch event names, if it is an events file. */
function agentOfPath(root: string, path: string): string | null {
  const parts = relative(root, path).split(sep);
  if (parts.length !== 2) return null;
  const [id, file] = parts as [string, string];
  return file.startsWith(AGENT_EVENTS_FILE) ? id : null;
}

/** How many agents the boot catch-up brings up at once. */
const BOOT_CATCH_UP_CONCURRENCY = 8;

/**
 * Start consuming: the watch, the question-answer listener, then one catch-up
 * of every live sdk conversation (what happened while no backend was up) and
 * a re-sync of every question an agent still holds open. Resolves the stop.
 */
export async function startConsumer(
  onSignal: (s: RuntimeSignal) => void,
): Promise<() => Promise<void>> {
  if (signal) throw new Error("runtime-sdk consumer: already started");
  signal = onSignal;
  const root = ownAgentsRoot();
  mkdirSync(root, { recursive: true });
  const watcher = await sdkEventsWatcher.start({
    dirs: [root],
    onChange: async (events) => {
      const ids = new Set<string>();
      for (const e of events) {
        const id = agentOfPath(root, e.path);
        if (id) ids.add(id);
      }
      // Heard before (and whatever) the catch-up does: a launch probing for a
      // stalled consumer must hear the agent write even when catch-up is wedged.
      for (const id of ids)
        for (const hear of appendListeners.get(id) ?? []) hear();
      for (const id of ids) if (await isOurs(id)) catchUps.trigger(id);
    },
  });
  const unlisten = onQuestionResolved(onResolved);
  // The rows expected live (an agent that exited while this backend was down
  // still has its last lines to read) and every agent actually running, whatever
  // its row says.
  const atBoot = new Set([
    ...(await liveSdkConversationIds()),
    ...(await runningAgentIds()),
  ]);
  // Agents are independent (a catch-up is one at a time per agent only), so
  // they are brought up together, a few at once: one after another, a boot
  // paid two round trips per agent in series, each queued behind the rest of
  // the boot.
  const gate = createSemaphore(BOOT_CATCH_UP_CONCURRENCY);
  await Promise.all(
    [...atBoot].map((id) =>
      gate.run(async () => {
        ours.add(id);
        await catchUps.run(id);
        await resyncOpenRequests(id);
      }),
    ),
  );
  return async () => {
    unlisten();
    await watcher.stop();
    signal = null;
  };
}

/** After a restart: every question the agent still holds is held (and answered) again. */
async function resyncOpenRequests(id: string): Promise<void> {
  let hello;
  try {
    hello = await helloAgent(id);
  } catch (err) {
    if (err instanceof AgentNotRunningError) return;
    throw err;
  }
  for (const request of hello.openRequests) {
    await syncOpenRequest(id, request, hello.pid);
  }
}

/** Apply what is on disk now, and wait for it (the runtime's own reads). */
export function catchUpNow(id: string): Promise<void> {
  return catchUps.run(id);
}

class CatchUpBudgetError extends Error {
  constructor(id: string) {
    super(`SDK agent ${id}: catch-up did not settle within its budget`);
    this.name = "CatchUpBudgetError";
  }
}

/**
 * {@link catchUpNow}, bounded: `overdue` when it has not settled within
 * `budgetMs` — this backend is not applying the agent's events (a run parked
 * behind a wedged one), and nothing read from the row since is current. The
 * run is not cancelled; it keeps going (and the overdue watchdog reports it).
 */
export async function catchUpWithin(
  id: string,
  budgetMs: number,
): Promise<"applied" | "overdue"> {
  try {
    await withDeadline(
      catchUpNow(id),
      budgetMs,
      () => new CatchUpBudgetError(id),
    );
    return "applied";
  } catch (err) {
    if (err instanceof CatchUpBudgetError) return "overdue";
    throw err;
  }
}

const appendListeners = new Map<string, Set<() => void>>();

/**
 * Hear every append to `id`'s events file, straight from the watch —
 * independent of catch-up, so a caller can tell "the agent writes" from "this
 * backend applies it". Returns the unsubscribe.
 */
export function onEventsAppended(id: string, hear: () => void): () => void {
  let set = appendListeners.get(id);
  if (!set) {
    set = new Set();
    appendListeners.set(id, set);
  }
  set.add(hear);
  return () => {
    set.delete(hear);
    if (set.size === 0) appendListeners.delete(id);
  };
}

/** The agent starts its event file over: read it from the start next time. */
export function forgetPosition(id: string): void {
  positions.delete(id);
}
