import { relative, sep } from "node:path";
import type { RuntimeSignal } from "@plugins/conversations/server";
import { defineFileWatcher } from "@plugins/infra/plugins/file-watcher/server";
import { createKeyedCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { recordReport } from "@plugins/reports/server";
import { resolvePromptSubmit } from "@plugins/conversations/plugins/turn-ledger/server";
import {
  holdQuestion,
  onQuestionResolved,
  retireQuestion,
  type ResolvedQuestion,
} from "@plugins/conversations/plugins/question-relay/server";
import {
  AGENT_EVENTS_FILE,
  DismissReplySchema,
  type OpenRequest,
} from "../../core";
import { sdkAgentsDir } from "../../data-dirs";
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
import { readAgentEvents, type ReadPosition } from "./event-reader";
import { agentReady } from "./partial-stream";
import { agentEventsPath } from "./paths";
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
 * The one watch over `state/sdk-agents/`: an append to any agent's events file
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

/** Where each agent's file was last read up to (lost on restart: the cursor replays). */
const positions = new Map<string, ReadPosition | null>();

/** Conversation ids seen on disk, by whether they are this DB's sdk rows. */
const ours = new Map<string, boolean>();

type Waiter = {
  until: (s: AgentProjection) => boolean;
  resolve: (s: AgentProjection) => void;
};
const waiters = new Map<string, Set<Waiter>>();

let signal: ((s: RuntimeSignal) => void) | null = null;

/** Mark `id` as this DB's sdk conversation (its `create` just ran here). */
export function adoptAgent(id: string): void {
  ours.set(id, true);
}

async function isOurs(id: string): Promise<boolean> {
  const known = ours.get(id);
  if (known !== undefined) return known;
  const mine = await isSdkConversation(id);
  // Another backend's agent stays "not ours" until this backend creates it.
  ours.set(id, mine);
  return mine;
}

/** {@link waitForProjection}'s bound ran out. */
export class ProjectionTimeoutError extends Error {
  constructor(id: string, what: string, timeoutMs: number) {
    super(`SDK agent ${id}: ${what} did not happen within ${timeoutMs}ms`);
    this.name = "ProjectionTimeoutError";
  }
}

/**
 * Wait until the conversation's applied projection satisfies `until` — checked
 * against the stored row first, then after every catch-up. Resolves the
 * projection; rejects after `timeoutMs`.
 */
export async function waitForProjection(
  id: string,
  until: (s: AgentProjection) => boolean,
  timeoutMs: number,
  what: string,
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
  try {
    // Registered before the read, so a catch-up landing in between wakes it.
    const current = await readAgentRow(id);
    if (current && until(current)) return current;
    // Lines may already be on disk that no watch event announced yet.
    catchUps.trigger(id);
    return await done;
  } finally {
    clearTimeout(timer);
    set.delete(waiter);
    if (set.size === 0) waiters.delete(id);
  }
}

const catchUps = createKeyedCoalescer<string>({
  run: (id) => catchUp(id),
});

/** Apply every line of `id`'s events file past its cursor. */
async function catchUp(id: string): Promise<void> {
  const row = await readAgentRow(id);
  // No row: `create` has not prepared one yet (it does before the agent starts).
  if (!row) return;
  const path = agentEventsPath(id);
  const read = readAgentEvents(path, positions.get(id) ?? null);
  const { worktreePath: _path, ...projection } = row;
  const { state, effects, gaps, malformed } = reduceEvents(
    projection,
    read.events,
  );
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
  // Side effects first, then the cursor: a crash in between replays the lines,
  // and every effect is idempotent (a prompt resolves once, a question
  // registration is an upsert).
  for (const effect of effects) await runEffect(id, effect);
  if (state.cursorSeq !== row.cursorSeq) await writeProjection(id, state);
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

const QuestionInputSchema = z.object({ questions: z.unknown() });

async function runEffect(id: string, effect: AgentEffect): Promise<void> {
  switch (effect.kind) {
    case "prompt-submitted":
      await resolvePromptSubmit(id, effect.text, effect.at);
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
  const root = sdkAgentsDir.ensure();
  const watcher = await sdkEventsWatcher.start({
    dirs: [root],
    onChange: async (events) => {
      const ids = new Set<string>();
      for (const e of events) {
        const id = agentOfPath(root, e.path);
        if (id) ids.add(id);
      }
      for (const id of ids) if (await isOurs(id)) catchUps.trigger(id);
    },
  });
  const unlisten = onQuestionResolved(onResolved);
  for (const id of await liveSdkConversationIds()) {
    ours.set(id, true);
    await catchUps.run(id);
    await resyncOpenRequests(id);
  }
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

/** The agent starts its event file over: read it from the start next time. */
export function forgetPosition(id: string): void {
  positions.delete(id);
}
