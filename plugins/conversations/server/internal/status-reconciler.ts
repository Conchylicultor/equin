import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { dirname } from "node:path";
import { z } from "zod";
import {
  listConversationsForInfra,
  updateConversation,
  markConversationGone,
  markConversationClosed,
  setConversationHibernated,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  conversationName,
  type Conversation,
} from "@plugins/tasks/plugins/tasks-core/core";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { conversationRoute } from "@plugins/conversations/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { spawnFailures } from "@plugins/conversations/plugins/spawn-failure/server";
import { describeSpawnFailure } from "@plugins/conversations/plugins/spawn-failure/core";
import { isTransientDbError } from "@plugins/database/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { Runtime, type RuntimeInspection, type RuntimeSignal } from "./runtime";
import { deliverHeldTurnsJob } from "./deliver-held-turns-job";
import { spawnConversationJob } from "./spawn-job";
import {
  readQuestionHolds,
  reapQuestionHolds,
  type QuestionHold,
} from "./question-hold";
import {
  planConversationUpdate,
  sessionCandidate,
  type Liveness,
  type UpdatePlan,
} from "./plan-update";
import {
  conversationsWithPendingTurn,
  latestSubmitAt,
  onStatusEvidence,
} from "@plugins/conversations/plugins/turn-ledger/server";
import {
  findTranscriptPath,
  onSessionTranscriptWritten,
  refreshConversationChain,
  resolveAnchoredChain,
} from "@plugins/conversations/plugins/transcript-watcher/server";
import {
  listSessionChain,
  recordSessionId,
} from "@plugins/conversations/plugins/session-chain/server";

// Keeps every conversation row's status, waitingFor and session id in step
// with its live agent session — from PUSH SIGNALS, not a poll.
//
//   - Each runtime delivers signals (`ConversationRuntime.subscribe`): for sdk,
//     a new line in an agent's event log. A signal only names WHO may have
//     changed; it accumulates in a
//     pending set and one batch at a time is reconciled: one `inspect()` per
//     runtime for the whole batch, the rows by id, then the pure decision
//     (plan-update.ts) per row. A burst of signals costs one batch, not N.
//   - Recovery from a missed signal (a watcher dropped an event, the backend was
//     down, a state with no signal — a "starting" row that never came up): one `reconcileAll()` at boot, and the every-minute
//     `conversations.status-sweep` job.
//
// Every reconcile — batches, the boot one, the sweep — runs through one
// one-at-a-time gate and reads the DB inside its turn, so the last writer is
// always the freshest read.
const reconcileGate = createSemaphore(1);

type LiveEntry = RuntimeInspection & { runtime: string };

interface LiveSnapshot {
  next: Map<string, LiveEntry>;
  failedRuntimes: Set<string>;
  /** The "starting" rows whose spawn job was still coming just before the runtimes were asked. */
  spawnsInFlight: ReadonlySet<string>;
}

/**
 * Ask every runtime what is live: all of it (`ids` omitted), or just `ids`. A
 * runtime that throws is recorded as failed — its conversations' state is
 * unknown, and the decision leaves them untouched.
 */
async function collectLive(
  rows: readonly Conversation[],
  ids?: readonly string[],
): Promise<LiveSnapshot> {
  // Asked FIRST: a spawn that finishes after this read has a session the
  // runtimes below report, so a starting row is never seen with neither.
  const spawnsInFlight = await spawnConversationJob.inFlight(
    rows.filter((r) => r.status === "starting").map((r) => r.id),
  );
  const merged = new Map<string, LiveEntry>();
  const failedRuntimes = new Set<string>();
  for (const runtime of Runtime.all()) {
    let entries: Map<string, RuntimeInspection>;
    try {
      entries = ids ? await runtime.inspect(ids) : await runtime.list();
    } catch (err) {
      failedRuntimes.add(runtime.id);
      console.error(
        `[conversations.status] runtime "${runtime.id}" ${ids ? "inspect" : "list"} failed`,
        err,
      );
      // eslint-disable-next-line promise-safety/no-bare-catch
      await recordReport({
        kind: "crash",
        source: "server-caught",
        message: `Runtime "${runtime.id}" ${ids ? "inspect" : "list"} failed: ${err instanceof Error ? err.message : String(err)}`,
        data: {
          errorType: "RuntimeListError",
          label: "conversations.status.runtimeList",
        },
      }).catch((e) => {
        console.error("[conversations.status] recordReport failed", e);
      });
      continue;
    }
    for (const [id, info] of entries) {
      if (merged.has(id)) {
        console.warn(
          `[conversations.status] conversation "${id}" claimed by multiple runtimes; last wins`,
        );
      }
      merged.set(id, { ...info, runtime: runtime.id });
    }
  }
  return { next: merged, failedRuntimes, spawnsInFlight };
}

/**
 * Should this conversation adopt `candidate` as its live session id?
 *
 * Two gates, in cost order — this runs only on the rare reconcile where the
 * runtime reports an id different from the stored one (`sessionCandidate`),
 * never on the steady-state path.
 *
 * 1. **A transcript must exist.** Otherwise a freshly-resumed session that dies
 *    before the user types anything would overwrite the (still-resumable) id
 *    with one that has no transcript on disk, breaking the next Resume. This
 *    refusal is only "not yet": `planFor` records it in `awaitingTranscript`,
 *    and the transcript's birth wakes the conversation again.
 *
 * 2. **That transcript must sit in THIS conversation's projects directory.**
 *    Gate 1 alone only asks whether a transcript exists *somewhere on the host*
 *    — `findTranscriptPath` globs every `~/.claude/projects/<dir>/`, so another
 *    conversation's session id in another worktree passes it cleanly. That is
 *    exactly how `conv-1786969506-7e03` adopted a stranger's session on
 *    2026-08-19 (`research/2026-08-19-global-pane-session-ownership.md`). All of
 *    a conversation's sessions run in one worktree, hence in one projects dir,
 *    so an id resolving elsewhere is somebody else's.
 *
 * A null anchor — nothing in the known chain resolves yet, i.e. the
 * conversation's first session — accepts, and the candidate becomes the anchor.
 *
 * Defense in depth, deliberately **not** load-bearing: the runtime resolver is
 * what must stop offering a foreign id in the first place. So this refuses
 * SILENTLY, exactly like "no transcript yet" always has — a broken pane would
 * hand us the same wrong id on every reconcile, and a report per reconcile is
 * noise, not an alarm. Standing corruption is the periodic monitor's signal to
 * raise.
 */
async function sessionGate(
  conversationId: string,
  storedSessionId: string | null,
  candidate: string,
): Promise<SessionGate> {
  const candidatePath = await findTranscriptPath(candidate);
  if (!candidatePath) return "no-transcript";

  // What we already believe about this conversation: its full chain, or — before
  // the chain has any row — the stored tail on its own.
  const chain = await listSessionChain(conversationId);
  const known = chain.length
    ? chain.map((entry) => entry.claudeSessionId)
    : storedSessionId
      ? [storedSessionId]
      : [];

  const { anchorDir } = await resolveAnchoredChain(known);
  return anchorDir === null || dirname(candidatePath) === anchorDir
    ? "accepted"
    : "foreign";
}

/** Why a session-id candidate was (not) adopted. */
type SessionGate = "accepted" | "no-transcript" | "foreign";

// Conversation id → the session id it was refused ONLY because that session's
// transcript did not exist yet. The CLI writes the sessions file (the signal
// that woke the reconcile) a moment BEFORE it creates `<sessionId>.jsonl`, and
// no later sessions-file write is due until the turn ends — so without a wake
// on the transcript's birth the id waited for the turn end or the sweep
// (research/2026-10-07-conversations-status-shadow-audit-retirement.md, class A).
// Kept current by every plan of the row (`planFor`); bounded by the active rows.
const awaitingTranscript = new Map<string, string>();

/** The conversations waiting on any of `sessionIds`' transcripts to appear. */
function awaitingAny(sessionIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const [conversationId, sessionId] of awaitingTranscript) {
    if (sessionIds.has(sessionId)) out.push(conversationId);
  }
  return out;
}

function livenessOf(row: Conversation, live: LiveSnapshot): Liveness {
  const entry = live.next.get(row.id);
  if (entry) {
    switch (entry.kind) {
      case "live":
        return { kind: "live", info: entry.info };
      case "unverified":
        return { kind: "unknown", reason: entry.reason };
    }
  }
  return live.failedRuntimes.has(row.runtime)
    ? {
        kind: "unknown",
        reason: `the "${row.runtime}" runtime did not answer`,
      }
    : { kind: "absent" };
}

/** One conversation's plan, with the async session-id gate run first. */
async function planFor(
  row: Conversation,
  live: LiveSnapshot,
  holds: ReadonlyMap<string, QuestionHold>,
  submits: ReadonlyMap<string, Date>,
  pending: ReadonlySet<string>,
): Promise<{ plan: UpdatePlan; liveness: Liveness }> {
  const liveness = livenessOf(row, live);
  const candidate = sessionCandidate(row, liveness);
  const gate =
    candidate === null
      ? null
      : await sessionGate(row.id, row.claudeSessionId, candidate);
  const plan = planConversationUpdate(row, liveness, {
    onMain: isMain(),
    now: Date.now(),
    sessionAccepted: gate === "accepted",
    questionHold: holds.get(row.id) ?? null,
    lastSubmitAt: submits.get(row.id) ?? null,
    turnPending: pending.has(row.id),
    spawnInFlight: live.spawnsInFlight.has(row.id),
  });
  const rowStaysLive = plan.kind === "noop" || plan.kind === "patch";
  if (candidate !== null && gate === "no-transcript" && rowStaysLive) {
    awaitingTranscript.set(row.id, candidate);
  } else {
    awaitingTranscript.delete(row.id);
  }
  return { plan, liveness };
}

async function apply(row: Conversation, plan: UpdatePlan): Promise<void> {
  const { id } = row;
  switch (plan.kind) {
    case "noop":
      return;
    case "closed":
      await markConversationClosed(id);
      return;
    case "hibernate":
      await setConversationHibernated(id, new Date());
      if (plan.endTurn || plan.clearUnverified) {
        await updateConversation(id, {
          ...(plan.endTurn
            ? { status: "waiting" as const, waitingFor: null }
            : {}),
          ...(plan.clearUnverified ? { statusUnverifiedSince: null } : {}),
        });
      }
      return;
    case "gone":
      // A "starting" row that never came up AND has no session to resume:
      // runtime.create's error path didn't run (server killed mid-create, the
      // pane vanished before the first reconcile, a future path that bypassed
      // handle-create's wrapper). The originating exception — if any — was
      // already reported by process-hooks; this is a separate signal that the
      // safety net actually fired.
      //
      // Its identity is its cause. When the spawn job recorded why the launch
      // failed, that sentence leads the message and no errorType is set, so
      // the crash fingerprint is the normalized message (ids and numbers
      // stripped): one report per distinct cause, each counting its own
      // repeats. Without a recorded cause, the declared StuckStartingError
      // type keeps every such sweep on the one report it has always had.
      if (plan.stuckStartingMs !== null) {
        const stuckFor = `${Math.round(plan.stuckStartingMs / 1000)}s`;
        const failure = await spawnFailures.get(id);
        // eslint-disable-next-line promise-safety/no-bare-catch
        await recordReport({
          kind: "crash",
          source: "server-caught",
          message: failure
            ? `Conversation never started — ${describeSpawnFailure(failure)} (${id} swept from "starting" to gone after ${stuckFor})`
            : `Conversation ${id} stuck in "starting" for ${stuckFor} with no live session and nothing to resume, and its spawn recorded no failure — sweeping to gone`,
          data: {
            errorType: failure ? null : "StuckStartingError",
            label: "conversations.status.startingTimeout",
          },
        }).catch((e) => {
          console.error("[conversations.status] recordReport failed", e);
        });
        // The user's half: the launch they asked for never came up. Sent
        // here — the spawn's final failure, once every retry has given up —
        // never per attempt.
        await recordNotification({
          type: "conversation",
          category: "conversations",
          title: "Couldn't start conversation",
          description: "",
          subjectId: id,
          subjectName: conversationName(row),
          detail: failure
            ? describeSpawnFailure(failure)
            : `stuck starting for ${stuckFor} with no session`,
          variant: "error",
          linkTo: conversationRoute.link(agentManagerApp, { convId: id }),
          dedupeKey: `conversation-start-failed:${id}`,
        });
      }
      await markConversationGone(id);
      return;
    case "patch":
      break;
  }

  await updateConversation(id, plan.patch);

  // Leaving `starting` for a live status: deliver any turn the user sent while
  // it was starting (turns.ts). A row swept to gone/done keeps its held
  // turns for the Resume that respawns it. Enqueued AFTER the status write on purpose — the write is
  // an UPDATE of the row every accept locks, so a turn the accept held before
  // it is already committed when the flush looks, and a turn accepted after it
  // saw the new status and was sent directly.
  if (
    row.status === "starting" &&
    (plan.patch.status === "working" || plan.patch.status === "waiting")
  ) {
    await deliverHeldTurnsJob.enqueue({ conversationId: id });
  }

  // `conversations.claude_session_id` is the live TAIL (what `claude --resume`
  // hands back); the chain is the full ordered history the transcript readers
  // merge. Every id the reconciler adopts — including the first, since `null →
  // sid` flows through this same branch — is appended here, behind the
  // adoption gate, so neither a session with no file on disk nor one whose file
  // lives in another conversation's directory ever enters the chain.
  //
  // Chain ORDER comes from `seenAt` = the DB's `now()`, which is TRANSACTION
  // START time. Safe here: each call is its own implicit transaction, and
  // reconciles are serialized through `reconcileGate`. A future caller appending
  // two ids inside one transaction would give them an identical `seenAt` and
  // scramble the chain order.
  if (plan.adoptedSessionId) {
    await recordSessionId(id, plan.adoptedSessionId);
    // Let any live subscriber follow the new file now, rather than at the next
    // 30s watcher reconcile.
    await refreshConversationChain(id);
  }
}

/** Reconcile `rows` (active rows). Inside the gate. */
async function reconcileRows(
  rows: Conversation[],
  live: LiveSnapshot,
): Promise<void> {
  // Held questions first retire the ones whose holder died (the agent process
  // can die mid-question), then are read once for the whole batch.
  // Independent reads, so they go together: one round trip, not four.
  const ids = rows.map((r) => r.id);
  const [holds, submits, pending] = await Promise.all([
    reapQuestionHolds(ids).then(() => readQuestionHolds(ids)),
    latestSubmitAt(ids),
    conversationsWithPendingTurn(ids),
  ]);
  for (const row of rows) {
    const { plan } = await planFor(row, live, holds, submits, pending);
    await apply(row, plan);
  }
}

/** Today's whole-world reconcile: every live session against every active row. */
function reconcileAll(): Promise<void> {
  return reconcileGate.run(async () => {
    // Every signal so far is answered by the reads below (rows and runtimes
    // are both read after it), so a batch still pending would only repeat them.
    pendingAll = false;
    pendingIds.clear();
    const rows = await listConversationsForInfra();
    await reconcileRows(rows, await collectLive(rows));
  });
}

/**
 * Reconcile just `ids`: the rows by id, then one inspect per runtime for the
 * batch. Only this backend's own rows are inspected, so a batch naming none of
 * them spawns nothing.
 */
function reconcileIds(ids: readonly string[]): Promise<void> {
  return reconcileGate.run(async () => {
    const rows = await listConversationsForInfra({ ids });
    if (rows.length === 0) return;
    const live = await collectLive(
      rows,
      rows.map((r) => r.id),
    );
    await reconcileRows(rows, live);
  });
}

// Signals accumulate here between batches. A signal that arrives while a batch
// is draining joins the next one, so a burst of N signals costs one batch.
const pendingIds = new Set<string>();
let pendingAll = false;
let draining = false;
// Until the boot reconcile has run, signals only accumulate: the boot catch-up
// signals every agent it applied lines for, and that one reconcile, reading
// after them, answers them all — reconciled as they came, each would be done
// twice, the boot reconcile waiting behind them at the gate.
let booted = false;

/**
 * Ask for `conversationIds` to be reconciled now — the same wake a runtime
 * signal is, for a state change the runtime cannot see (a question hold opened,
 * answered or released). Joins the pending batch; never waits.
 */
export function requestStatusReconcile(conversationIds: string[]): void {
  onSignal({ conversationIds });
}

function onSignal(signal: RuntimeSignal): void {
  if ("conversationIds" in signal) {
    for (const id of signal.conversationIds) pendingIds.add(id);
  } else {
    pendingAll = true;
  }
  startDrain();
}

/** Drain the pending signals, unless a drain is already doing so (or boot has not reconciled yet). */
function startDrain(): void {
  if (booted && !draining) {
    draining = true;
    void runTracked("conversations:status-reconcile", () =>
      drain().catch((err: unknown) => {
        // Transient = central is restarting / catching up. The undrained
        // signals stay pending for the next one, and the sweep re-derives
        // everything within a minute; logging would just spam the recovery
        // window. Anything else is loud.
        if (isTransientDbError(err)) return;
        throw err;
      }),
    );
  }
}

async function drain(): Promise<void> {
  try {
    while (pendingAll || pendingIds.size > 0) {
      if (pendingAll) {
        pendingAll = false;
        pendingIds.clear();
        await reconcileAll();
        continue;
      }
      const ids = [...pendingIds];
      pendingIds.clear();
      if (ids.length > 0) await reconcileIds(ids);
    }
  } finally {
    draining = false;
  }
}

/**
 * Subscribe to every runtime's signals, then reconcile the whole world once:
 * live state is the runtimes', not ours, so a restart re-derives it — and any
 * transition missed while this backend was down lands here. Fails loudly: a
 * runtime whose signals cannot open would leave its conversations frozen.
 */
export async function startStatusReconciler(): Promise<void> {
  for (const runtime of Runtime.all()) {
    await runtime.subscribe(onSignal);
  }
  // The one state no runtime signal carries: a refused session id's transcript
  // appearing (see `awaitingTranscript`).
  onSessionTranscriptWritten((sessionIds) => {
    const conversationIds = awaitingAny(sessionIds);
    if (conversationIds.length > 0) onSignal({ conversationIds });
  });
  // The ledger's evidence moved: a turn just confirmed submitting is working
  // whatever the runtime's last status write said, and a turn entering or
  // leaving a pending state moves the status with it (see `liveStatusFor`).
  onStatusEvidence((conversationId) => {
    onSignal({ conversationIds: [conversationId] });
  });
  try {
    await reconcileAll();
  } finally {
    // Even when it threw (the hook fails loudly): signals must not be held
    // for the process's lifetime. What arrived while it ran drains now.
    booted = true;
    startDrain();
  }
}

// The missed-signal backstop, and the one path for the states that have no
// signal at all (a "starting" row whose agent never came up). Every backend reconciles its own rows, so it runs per worktree.
export const conversationsStatusSweepJob = defineJob({
  name: "conversations.status-sweep",
  description:
    "Once a minute, re-reads every agent session and reconciles each conversation's status — the backstop for a push signal that was missed, and for a conversation stuck starting.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "* * * * *", perWorktree: true },
  maxAttempts: 1,
  run: () => reconcileAll(),
});
