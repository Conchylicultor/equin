import { mkdir } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { RuntimeSignal } from "@plugins/conversations/server";
import { recordContextUsage } from "@plugins/conversations/plugins/context-usage/server";
import {
  acquireDirWatch,
  defineFileWatcher,
  WatchedDirGoneError,
  type FileWatcher,
} from "@plugins/infra/plugins/file-watcher/server";
import {
  createCoalescer,
  createKeyedCoalescer,
} from "@plugins/packages/plugins/coalesce/core";
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
} from "../../server/internal/rows";
import {
  currentAgentRow,
  leaseAgentRow,
  type AgentRowLease,
} from "./agent-row-lease";
import { requestAutoResume } from "./auto-resume";
import { readEventsAfter } from "./event-reader";
import type { ReadPosition } from "../../server/internal/read-position";
import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  liveAgentIds,
  onAgentProcessesRecount,
  runningAgentIds,
} from "./agent-processes";
import { agentReady } from "./partial-stream";
import { reportedStateChanged } from "./runtime-info";
import {
  agentDir,
  agentEventsExist,
  agentEventsPath,
  ownAgentPidsDir,
  ownAgentsRoot,
} from "./paths";
import {
  AgentNotRunningError,
  commandAgent,
  helloAgent,
} from "./socket-client";
import { z } from "zod";

// Events → state: tails every SDK agent's events.jsonl from the cursor its
// conversation row holds, applies the new lines (reducer.ts), runs their side
// effects (the turn ledger, the question relay) and signals the status
// reconciler. Push-based end to end: a kqueue watch of each RUNNING agent's own
// directory (fs.watch never reports appends under bun), one catch-up per
// conversation at a time (a keyed coalescer folds a burst into one trailing
// run), and in-process waiters for the runtime's own "wait until the agent
// did X" (stop, ready).

/**
 * The watch of one running agent's directory, `state/sdk-agents/<ns>/<id>/`:
 * an append to its events file wakes that conversation's catch-up. kqueue
 * (`writesWhileOpen`) because FSEvents reports an append to a file still held
 * open only when it closes. kqueue holds one descriptor per entry, so it is
 * opened per running agent (a handful of files; `bin/`'s clones ignored), never
 * over the whole namespace: that tree keeps every agent the namespace ever ran
 * (2026-11-05: 1,059 dirs, 5,016 entries on main — ~4,400 descriptors held, and
 * past the 5,000-entry ceiling every boot threw in onReady:conversations, a
 * crash loop). See {@link followAgent}.
 */
export const sdkEventsWatcher = defineFileWatcher({
  name: "runtime-sdk.events",
  description:
    "Notices a running SDK agent appending to its events.jsonl, so this backend applies the new lines to the conversation's status, turns and questions.",
  writesWhileOpen: true,
  ignore: ["bin"],
  debounceMs: 10,
});

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

/**
 * Agents whose next applied batch signals the reconciler whatever it moved:
 * an inspect found the agent ahead of its projection (or not answering), so the
 * reconciler marked it unverified, and the batch that brings it current is
 * what clears that.
 */
const owedSignals = new Set<string>();

/** Signal the reconciler after `id`'s next applied batch, whatever it moves. */
export function signalNextBatch(id: string): void {
  owedSignals.add(id);
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
    const current = await currentAgentRow(id);
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

// A catch-up runs a few idempotent effects and writes the row:
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

/**
 * Apply every line of `id`'s events file past its cursor — under the row's
 * lease, so it starts from the row as last written (no read per batch) and no
 * launch write lands between its read and its write.
 */
function catchUp(id: string, progress: CatchUpProgress): Promise<void> {
  progress.stage = "lease";
  return leaseAgentRow(id, async (lease) => {
    try {
      await applyNewLines(id, lease, progress);
    } finally {
      // An agent no longer followed writes nothing more: its row is read
      // again by whatever catches it up next.
      if (!followed.has(id)) lease.release();
    }
  });
}

async function applyNewLines(
  id: string,
  lease: AgentRowLease,
  progress: CatchUpProgress,
): Promise<void> {
  const row = lease.row;
  if (!row) {
    // No row and no events: `create` has not prepared the row yet (it does
    // before the agent starts). Events with no row are an agent this backend
    // cannot apply — say so, rather than skip them forever.
    if (!(await agentEventsExist(id))) return;
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
  // Read on from where the cursor's line ends — also after a restart, which
  // reads what was appended while no backend ran, not every generation of the
  // agent's history (hundreds of MB across the live agents, parsed on every
  // boot).
  const read = await readEventsAfter(
    path,
    projection.cursorSeq,
    eventsPosition,
  );
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
      message: `SDK agent ${id}: event ${bad.seq} (${bad.event}) in ${path} did not parse, so it was skipped; the conversation's status (or context reading) may be wrong until a later event corrects it — ${bad.issue}`,
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
    await lease.update({ ...state, eventsPosition: read.position });
  // A usage limit stopped it (written first: the job reads the row).
  if (
    state.stopError === USAGE_LIMIT_ERROR &&
    state.stoppedAt !== null &&
    state.stoppedAt.getTime() !== projection.stoppedAt?.getTime()
  )
    await requestAutoResume();
  progress.stage = "signal";
  if (read.events.length === 0) return;
  // A (re)started agent takes `subscribe` now: a watched partial reconnects.
  if (
    read.events.some((e) => e.kind === "agent" && e.payload.event === "ready")
  )
    agentReady(id);
  // Only a batch that moves what `inspect` would answer wakes the reconciler
  // (see `reportedStateChanged`) — or one an inspect is waiting on. The rest
  // (assistant text, tool calls) advance the cursor and nothing it reads: a
  // signal per batch re-ran its whole pass for a no-op plan, ~1/s per working
  // agent (2026-11-06: 3,257 reconciles in 52 min on main, ~7.6 acquires each).
  const owed = owedSignals.delete(id);
  if (owed || reportedStateChanged(projection, state))
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
    case "context-measured":
      await recordContextUsage(id, effect.usage);
      return;
    case "context-unmeasured":
      await recordReport({
        kind: "crash",
        source: "server-caught",
        message: `SDK agent ${id}: it could not measure its context window (event ${String(effect.seq)}), so the conversation keeps its previous reading — ${effect.error}`,
        data: {
          errorType: "SdkContextUsageFailed",
          label: "runtime-sdk.context-usage",
        },
      });
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
  const row = await currentAgentRow(q.conversationId);
  if (!row || row.openToolUseId !== q.toolUseId || !row.openRequestId) return;
  await deliver(q.conversationId, row.openRequestId, q.resolution);
}

/** Whether a watch event of an agent's directory names its events file (a rotated generation included). */
function isEventsPath(dir: string, path: string): boolean {
  const name = relative(dir, path);
  return !name.includes(sep) && name.startsWith(AGENT_EVENTS_FILE);
}

/** One followed agent: its directory's watch, and the launches pinning it. */
interface Follow {
  /** Resolves once the watch is open; rejects when it could not be. */
  watch: Promise<FileWatcher>;
  /** Launches under way: an agent not running yet is not unfollowed meanwhile. */
  launches: number;
}

/**
 * The agents this backend follows — each one's directory watched while its
 * process runs (its pid file names a live pid), or while a launch is starting
 * it. What the watch costs is bounded by the agents running, not by how many
 * the namespace has ever run.
 */
const followed = new Map<string, Follow>();

/**
 * An unfollowed agent's watch still closing. A follow of the same agent (a
 * relaunch right after its stop) opens its watch only once that one is closed,
 * so two native watches of one directory never overlap.
 */
const closing = new Map<string, Promise<void>>();

/**
 * Watch `id`'s directory (idempotent; registered at once, so a caller can pin
 * it before anything awaits), then catch up: lines the agent wrote before the
 * watch was open produced no event. Its `watch` rejects when the watch cannot
 * be opened, and the agent is then not followed.
 *
 * Only this namespace's agents are followed (their pid files, or this
 * backend's own launch), so every one is this DB's conversation.
 */
function followAgent(id: string): Follow {
  const known = followed.get(id);
  if (known) return known;
  const dir = agentDir(id);
  const follow: Follow = {
    launches: 0,
    watch: (closing.get(id) ?? Promise.resolve())
      .then(() => mkdir(dir, { recursive: true }))
      .then(() =>
        sdkEventsWatcher.start({
          dirs: [dir],
          label: id,
          onChange: async (events) => {
            if (!events.some((e) => isEventsPath(dir, e.path))) return;
            // Heard before (and whatever) the catch-up does: a launch probing
            // for a stalled consumer must hear the agent write even when
            // catch-up is wedged.
            for (const hear of appendListeners.get(id) ?? []) hear();
            catchUps.trigger(id);
          },
          onLost: async (_dir, error) => {
            // Its directory went: this watch hears nothing more. The scan
            // follows it again if its agent still runs.
            if (error instanceof WatchedDirGoneError) {
              await unfollowAgent(id, follow);
              followScan.trigger();
            }
            // Events may have been dropped: read what is on disk.
            catchUps.trigger(id);
          },
        }),
      )
      .then(
        (watch) => {
          catchUps.trigger(id);
          return watch;
        },
        (err: unknown) => {
          if (followed.get(id) === follow) followed.delete(id);
          throw err;
        },
      ),
  };
  followed.set(id, follow);
  return follow;
}

/**
 * Stop watching `id`'s directory — `only` that follow when given (a watch
 * reporting its own loss must not close a newer one) — then read what its
 * agent wrote last.
 */
async function unfollowAgent(id: string, only?: Follow): Promise<void> {
  const follow = followed.get(id);
  if (!follow || (only && follow !== only)) return;
  followed.delete(id);
  const closed = follow.watch.then(
    (watch) => watch.stop(),
    // It never opened: whoever opened it answers for that (a launch fails, the
    // scan files a report).
    () => undefined,
  );
  closing.set(id, closed);
  try {
    await closed;
  } finally {
    if (closing.get(id) === closed) closing.delete(id);
  }
  catchUps.trigger(id);
}

/**
 * Follow `id` for the length of `launch`, which starts its process: the
 * agent writes its first events before its pid file says it runs. Once the
 * launch settles, the pid files decide (a failed launch is unfollowed unless
 * its agent runs after all). The pid file lands just after the `started`
 * event the launch waits for, so a scan in between may unfollow it for a
 * moment; the pid file's own event follows it again and catches up, so no
 * line goes unread.
 */
export async function followLaunch<T>(
  id: string,
  launch: () => Promise<T>,
): Promise<T> {
  const follow = followAgent(id);
  follow.launches += 1;
  try {
    await follow.watch;
    return await launch();
  } finally {
    follow.launches -= 1;
    followScan.trigger();
  }
}

/**
 * Bring the followed set in line with the agents running now: follow each one
 * whose pid file names a live pid, unfollow each one whose process is gone (and
 * no launch holds). An agent whose watch cannot be opened is reported, not
 * thrown: one agent's directory must never fail the rest, nor a boot.
 */
async function syncFollowed(): Promise<void> {
  let running: Set<string>;
  try {
    running = new Set(await liveAgentIds(runtimeNamespace()));
  } catch (err) {
    // The pid files could not be read: the followed set stays as it is until
    // the next pid-file change or recount.
    await recordReport({
      kind: "crash",
      source: "server-caught",
      message: `SDK agents: the running agents' pid files could not be read, so which agents' events are watched was not updated — ${err instanceof Error ? err.message : String(err)}`,
      data: { errorType: "SdkEventsWatchFailed", label: "runtime-sdk.events" },
    });
    return;
  }
  for (const id of running) {
    if (followed.has(id)) continue;
    try {
      await followAgent(id).watch;
    } catch (err) {
      await reportFollowFailure(id, "could not be watched", err);
    }
  }
  for (const [id, follow] of [...followed]) {
    if (running.has(id) || follow.launches > 0) continue;
    try {
      await unfollowAgent(id, follow);
    } catch (err) {
      await reportFollowFailure(id, "could not stop being watched", err);
    }
  }
}

async function reportFollowFailure(
  id: string,
  what: string,
  err: unknown,
): Promise<void> {
  await recordReport({
    kind: "crash",
    source: "server-caught",
    message: `SDK agent ${id}: its directory ${agentDir(id)} ${what}, so its new events are applied only when something else reads them — ${err instanceof Error ? err.message : String(err)}`,
    data: { errorType: "SdkEventsWatchFailed", label: "runtime-sdk.events" },
  });
}

const followScan = createCoalescer({ run: () => syncFollowed() });

/** How many agents the boot catch-up brings up at once. */
const BOOT_CATCH_UP_CONCURRENCY = 8;

/**
 * Start consuming: the running agents' watches (kept in line with their pid
 * files), the question-answer listener, then one catch-up of every live sdk
 * conversation (what happened while no backend was up) and a re-sync of every
 * question an agent still holds open. Resolves the stop.
 */
export async function startConsumer(
  onSignal: (s: RuntimeSignal) => void,
): Promise<() => Promise<void>> {
  if (signal) throw new Error("runtime-sdk consumer: already started");
  signal = onSignal;
  await mkdir(ownAgentsRoot(), { recursive: true });
  const pidsDir = ownAgentPidsDir();
  await mkdir(pidsDir, { recursive: true });
  // An agent starting or exiting adds or removes its pid file; one killed
  // outright leaves it behind, which the reconciler's recount notices.
  const releasePids = await acquireDirWatch({
    dir: pidsDir,
    scope: "children",
    onChange: () => followScan.trigger(),
  });
  const unrecount = onAgentProcessesRecount(() => followScan.trigger());
  await followScan.run();
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
    unrecount();
    releasePids();
    await followScan.idle();
    await Promise.all([...followed.keys()].map((id) => unfollowAgent(id)));
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

/**
 * Prepare the row a launch of `id` starts from, under the row's lease: the
 * existing row with the launch's workspace path and session (the cursor and
 * projection carry on — a restarted agent continues its predecessor's
 * numbering), or — `eventsExist: false`, the agent's directory has no event
 * file at all (reclaimed, or never written) — a fresh one, since the agent
 * will number from 1 again. Either way the row names the session the launch
 * runs under (`AgentLaunchOptions.sessionId`), so the conversation has its
 * transcript from launch on. Marks the conversation as this DB's.
 */
export async function prepareLaunchRow(
  id: string,
  worktreePath: string,
  eventsExist: boolean,
  sessionId: string,
): Promise<void> {
  await leaseAgentRow(id, async (lease) => {
    if (lease.row && eventsExist)
      await lease.update({ worktreePath, sessionId });
    else await lease.reset(worktreePath, sessionId);
  });
  ours.add(id);
}

/** A relaunch under another session (a rewind of the session's first turn). */
export async function recordLaunchSession(
  id: string,
  sessionId: string,
): Promise<void> {
  await leaseAgentRow(id, async (lease) => {
    if (!(await lease.update({ sessionId })))
      throw new Error(
        `SDK agent ${id}: a relaunch found no conversations_ext_sdk_agent row to record its session on`,
      );
  });
}
