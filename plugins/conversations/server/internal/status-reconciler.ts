import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { CONVERSATIONS_CATEGORY_ID } from "../../core/task-category";
import { dirname } from "node:path";
import { z } from "zod";
import {
  listConversationsForInfra,
  listExistingConversationIds,
  updateConversation,
  updateTaskTitle,
  adoptOrphanConversation,
  markConversationGone,
  markConversationClosed,
  setConversationHibernated,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  ADOPTED_SPAWNED_BY,
  type Conversation,
} from "@plugins/tasks/plugins/tasks-core/core";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { Workspace } from "@plugins/conversations/plugins/workspace/server";
import { recordReport } from "@plugins/reports/server";
import { isTransientDbError } from "@plugins/database/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";
import { getConfig } from "@plugins/config_v2/server";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import {
  DEFAULT_MODEL_CHOICE,
  requireModel,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  Runtime,
  flushInteractivePrompt,
  type RuntimeInfo,
  type RuntimeSignal,
} from "./runtime";
import { autoAnswerConfig } from "../../shared/config";
import type { EmitTx } from "@plugins/infra/plugins/events/server";
import { conversationCreated } from "./tables-created-event";
import { deliverHeldTurnsJob } from "./deliver-held-turns-job";
import {
  readQuestionHolds,
  reapQuestionHolds,
  type QuestionHold,
} from "./question-hold";
import {
  planConversationUpdate,
  sessionCandidate,
  UNINFORMATIVE_TITLES,
  type Liveness,
  type UpdatePlan,
} from "./plan-update";
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

// Keeps every conversation row's status, waitingFor, title and session id in
// step with its live agent session — from PUSH SIGNALS, not a poll.
//
//   - Each runtime delivers signals (`ConversationRuntime.subscribe`): for tmux,
//     a sessions-file write, a tmux session hook, an agent's question hook, an
//     op marker. A signal only names WHO may have changed; it accumulates in a
//     pending set and one batch at a time is reconciled: one `inspect()` per
//     runtime for the whole batch, the rows by id, then the pure decision
//     (plan-update.ts) per row. A burst of signals costs one batch, not N.
//   - Recovery from a missed signal (a watcher dropped an event, the backend was
//     down, a state with no signal — a pane title, a "starting" row that never
//     came up): one `reconcileAll()` at boot, and the every-minute
//     `conversations.status-sweep` job.
//
// Every reconcile — batches, the boot one, the sweep — runs through one
// one-at-a-time gate and reads the DB inside its turn, so the last writer is
// always the freshest read.
const reconcileGate = createSemaphore(1);

interface LiveEntry extends RuntimeInfo {
  runtime: string;
}

interface LiveSnapshot {
  next: Map<string, LiveEntry>;
  failedRuntimes: Set<string>;
}

/**
 * Ask every runtime what is live: all of it (`ids` omitted), or just `ids`. A
 * runtime that throws is recorded as failed — its conversations' state is
 * unknown, and the decision leaves them untouched.
 */
async function collectLive(ids?: readonly string[]): Promise<LiveSnapshot> {
  const merged = new Map<string, LiveEntry>();
  const failedRuntimes = new Set<string>();
  for (const runtime of Runtime.all()) {
    let entries: Map<string, RuntimeInfo>;
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
  return { next: merged, failedRuntimes };
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
  const info = live.next.get(row.id);
  if (info) return { kind: "live", info };
  return live.failedRuntimes.has(row.runtime)
    ? { kind: "unknown" }
    : { kind: "absent" };
}

/** One conversation's plan, with the async session-id gate run first. */
async function planFor(
  row: Conversation,
  live: LiveSnapshot,
  holds: ReadonlyMap<string, QuestionHold>,
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
  });
  const rowStaysLive = plan.kind === "noop" || plan.kind === "patch";
  if (candidate !== null && gate === "no-transcript" && rowStaysLive) {
    awaitingTranscript.set(row.id, candidate);
  } else {
    awaitingTranscript.delete(row.id);
  }
  return { plan, liveness };
}

/**
 * The live ids with no row in ANY status — the orphan candidates. The active
 * row set excludes terminal (`done`) rows, so filtering on it alone would
 * re-classify a lingering `done` session as an orphan and re-adopt it (a
 * zero-row INSERT … ON CONFLICT DO NOTHING) on every reconcile, churning the
 * change-feed. Main-only: nothing else adopts.
 */
async function orphansOf(
  live: LiveSnapshot,
  activeIds: ReadonlySet<string>,
): Promise<string[]> {
  if (!isMain()) return [];
  const candidates = [...live.next.keys()].filter((id) => !activeIds.has(id));
  const existing = await listExistingConversationIds(candidates);
  return candidates.filter((id) => !existing.has(id));
}

async function adopt(
  id: string,
  info: LiveEntry,
  plan: Extract<UpdatePlan, { kind: "adopt" }>,
): Promise<void> {
  try {
    // Never adopt a session whose cwd is not a workspace of a registered kind
    // (`<root of its kind>/<id>`). Stray sessions started in /tmp or the repo
    // root are not Singularity attempts; adopting them would synthesize a
    // phantom attempt row no reaper can ever act on.
    const workspace = await Workspace.resolvePath(info.worktreePath);
    if (workspace === "none") return;
    const adopted = await adoptOrphanConversation({
      id,
      workspace: {
        attemptId: workspace.attemptId,
        path: info.worktreePath,
        // A worktree is fully described by its kind; a scratch workspace's
        // profile and input live only on its attempt row.
        spec: workspace.kind === "worktree" ? { kind: "worktree" } : null,
      },
      runtimeId: info.runtime,
      status: plan.status,
      title: plan.title,
      // What a stray session runs is not known; record the default family's
      // current version.
      model: requireModel(DEFAULT_MODEL_CHOICE, getModelCatalog()),
      // An adopted conversation is created like any other: announce it on the
      // adoption's tx, so its subscribers (queue rank, title generation, …) run
      // for it too — without a rank the sidebar queue has no section to put it in.
      onAdopted: (tx, { conversation, taskId }) =>
        conversationCreated.emit(
          {
            conversationId: conversation.id,
            taskId,
            model: conversation.model,
            spawnedBy: ADOPTED_SPAWNED_BY,
            createdAt: conversation.createdAt.toISOString(),
            kind: conversation.kind,
          },
          // Same narrow cast as lifecycle's `commitConversation`: a
          // PgTransaction is structurally the facade EmitTx names.
          { tx: tx as EmitTx },
        ),
    });
    // Adoption synthesized a fresh root task — stamp it like every other
    // auto-created conversation task. Linked-to-existing-attempt adoptions keep
    // the task's original category.
    if (adopted?.createdTaskId) {
      await setTaskCategory(adopted.createdTaskId, CONVERSATIONS_CATEGORY_ID);
    }
  } catch (err) {
    console.error(`[conversations.status] adopt orphan "${id}" failed`, err);
    // eslint-disable-next-line promise-safety/no-bare-catch
    await recordReport({
      kind: "crash",
      source: "server-caught",
      message: `Failed to adopt orphan conversation ${id}: ${err instanceof Error ? err.message : String(err)}`,
      data: {
        errorType: "OrphanAdoptionError",
        label: "conversations.status.adoptOrphan",
      },
    }).catch((e) => {
      console.error("[conversations.status] recordReport failed", e);
    });
  }
}

async function apply(row: Conversation, plan: UpdatePlan): Promise<void> {
  const { id } = row;
  switch (plan.kind) {
    case "noop":
    case "adopt": // only ever planned for a row-less id (see `orphansOf`)
      return;
    case "closed":
      await markConversationClosed(id);
      return;
    case "hibernate":
      await setConversationHibernated(id, new Date());
      if (plan.endTurn) {
        await updateConversation(id, { status: "waiting", waitingFor: null });
      }
      return;
    case "gone":
      // A "starting" row that never came up AND has no session to resume:
      // runtime.create's error path didn't run (server killed mid-create, the
      // pane vanished before the first reconcile, a future path that bypassed
      // handle-create's wrapper). The originating exception — if any — was
      // already reported by process-hooks; this is a separate signal that the
      // safety net actually fired. Dedup keeps repeats collapsed into one task
      // with a growing count.
      if (plan.stuckStartingMs !== null) {
        // eslint-disable-next-line promise-safety/no-bare-catch
        await recordReport({
          kind: "crash",
          source: "server-caught",
          message: `Conversation ${id} stuck in "starting" for ${Math.round(plan.stuckStartingMs / 1000)}s with no live session and nothing to resume — sweeping to gone`,
          data: {
            errorType: "StuckStartingError",
            label: "conversations.status.startingTimeout",
          },
        }).catch((e) => {
          console.error("[conversations.status] recordReport failed", e);
        });
      }
      await markConversationGone(id);
      return;
    case "patch":
      break;
  }

  await updateConversation(id, plan.patch);

  // Leaving `starting` for a live status: deliver any turn the user sent while
  // it was starting (held-turns.ts). A row swept to gone/done keeps its held
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

  if (plan.taskTitle) {
    await updateTaskTitle(row.taskId, plan.taskTitle, UNINFORMATIVE_TITLES);
  }

  // Auto-open question prompts: the moment a conversation enters the
  // interactive-question wait, optionally dismiss the terminal menu for the
  // user — exactly what clicking "Answer here" does, just done on detection.
  // Gated on the transition so it fires once per question: the flush clears the
  // menu, the next reconcile reads idle, and waitingFor goes null.
  // Fire-and-forget — the self-healing Escape loop must not hold the reconcile
  // gate. On failure the row stays at "question" and the manual "Answer here"
  // button remains as the fallback.
  if (plan.menuOpened && getConfig(autoAnswerConfig).enabled) {
    void runTracked("conversations:flush-interactive-prompt", () =>
      flushInteractivePrompt(id).catch((err) => {
        void recordReport({
          kind: "crash",
          source: "server-caught",
          message: `Auto-open question prompt for ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
          data: {
            errorType: "AutoAnswerFlushError",
            label: "conversations.status.autoAnswerFlush",
          },
        });
      }),
    );
  }
}

/** Reconcile `rows` (active rows) plus the orphans in `live`. Inside the gate. */
async function reconcileRows(
  rows: Conversation[],
  live: LiveSnapshot,
): Promise<void> {
  const activeIds = new Set(rows.map((r) => r.id));
  for (const id of await orphansOf(live, activeIds)) {
    const info = live.next.get(id)!;
    const plan = planConversationUpdate(
      null,
      { kind: "live", info },
      {
        onMain: true,
        now: Date.now(),
        sessionAccepted: false,
        questionHold: null,
      },
    );
    if (plan.kind === "adopt") await adopt(id, info, plan);
  }
  // Held questions first retire the ones whose holder died (Escape in the
  // terminal SIGTERMs the hook, the agent or pane can die), then are read once
  // for the whole batch.
  const ids = rows.map((r) => r.id);
  await reapQuestionHolds(ids);
  const holds = await readQuestionHolds(ids);
  for (const row of rows) {
    const { plan } = await planFor(row, live, holds);
    await apply(row, plan);
  }
}

/** Today's whole-world reconcile: every live session against every active row. */
function reconcileAll(): Promise<void> {
  return reconcileGate.run(async () => {
    const [live, rows] = await Promise.all([
      collectLive(),
      listConversationsForInfra(),
    ]);
    await reconcileRows(rows, live);
  });
}

/**
 * Reconcile just `ids`: the rows by id, then one inspect per runtime for the
 * batch. tmux is host-wide, so most ids a signal names are other backends'
 * conversations: only this backend's own rows — plus, on main, ids with no row
 * in any status (orphan candidates) — are inspected, and a batch naming none
 * of them spawns nothing.
 */
function reconcileIds(ids: readonly string[]): Promise<void> {
  return reconcileGate.run(async () => {
    const rows = await listConversationsForInfra({ ids });
    const inspected = new Set(rows.map((r) => r.id));
    if (isMain()) {
      const missing = ids.filter((id) => !inspected.has(id));
      const existing = await listExistingConversationIds(missing);
      for (const id of missing) if (!existing.has(id)) inspected.add(id);
    }
    if (inspected.size === 0) return;
    const live = await collectLive([...inspected]);
    await reconcileRows(rows, live);
  });
}

// Signals accumulate here between batches. A signal that arrives while a batch
// is draining joins the next one, so a burst of N signals costs one batch.
const pendingIds = new Set<string>();
const pendingWorktrees = new Set<string>();
let pendingAll = false;
let draining = false;

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
  } else if ("worktreeName" in signal) {
    pendingWorktrees.add(signal.worktreeName);
  } else {
    pendingAll = true;
  }
  if (!draining) {
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
    while (pendingAll || pendingIds.size > 0 || pendingWorktrees.size > 0) {
      if (pendingAll) {
        pendingAll = false;
        pendingIds.clear();
        pendingWorktrees.clear();
        await reconcileAll();
        continue;
      }
      const worktrees = [...pendingWorktrees];
      pendingWorktrees.clear();
      for (const worktreeName of worktrees) {
        for (const row of await listConversationsForInfra({ worktreeName })) {
          pendingIds.add(row.id);
        }
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
  await reconcileAll();
}

// The missed-signal backstop, and the one path for the states that have no
// signal at all (a pane title change, a "starting" row whose pane never came
// up). Every backend reconciles its own rows, so it runs per worktree.
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
