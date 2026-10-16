import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { CONVERSATIONS_CATEGORY_ID } from "../../core/task-category";
import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createTask,
  createAttempt,
  getAttemptRow,
  insertConversation,
  getConversation,
  getConversationRuntime,
  updateConversation,
  updateTask,
  setConversationHibernated,
  withTaskStatusBatch,
  type DbExecutor,
} from "@plugins/tasks/plugins/tasks-core/server";
import type { EmitTx } from "@plugins/infra/plugins/events/server";
import { Runtime } from "./runtime";
import {
  assertClaudeCodeReady,
  checkClaudeCode,
} from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { claudeCodeBlockMessage } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import {
  DEFAULT_MODEL_CHOICE,
  requireModel,
  type ConversationModel,
  type ModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import type {
  Conversation,
  ConversationKind,
} from "@plugins/tasks/plugins/tasks-core/core";
import {
  attemptIdKind,
  conversationIdKind,
} from "@plugins/tasks/plugins/task-ids/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  DEFAULT_WORKSPACE,
  type WorkspaceSpec,
} from "@plugins/conversations/plugins/workspace/core";
import {
  Workspace,
  workspaceOfAttempt,
  type WorkspaceAt,
} from "@plugins/conversations/plugins/workspace/server";
import { spawnConversationJob } from "./spawn-job";
import { deliverHeldTurnsJob } from "./deliver-held-turns-job";
import { conversationCreated } from "./tables-created-event";
import { resolveAttachmentRefs } from "./resolve-prompt-attachments";
import { resolvePreprompt } from "@plugins/conversations/plugins/preprompts/server";
import { getTaskPreprompt } from "@plugins/tasks/plugins/task-preprompt/server";
import { getTaskEffort } from "@plugins/tasks/plugins/task-effort/server";
import { getTaskWorkspace } from "@plugins/conversations/plugins/workspace/plugins/launch-option/server";
import type { EffortLevel } from "@plugins/conversations/plugins/effort-provider/core";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { wrapPreprompt } from "@plugins/conversations/plugins/transcript-watcher/core";
import type {
  ResumeBlocked,
  ResumeBlockedReason,
  ResumeOutcome,
} from "../../core/resume-outcome";
import { serializeTranscript } from "./claude-transcript";
import { locateTranscriptCut, type LocateCutRefusal } from "./locate-cut";
import type { RewindOutcome, RewindPreview } from "../../core/rewind";

const DEFAULT_RUNTIME = "tmux";

// The per-task thinking mode (effort), applied to Claude Code at launch and on
// resume. Read live from the task side-table (no per-conversation snapshot), so
// changing a task's mode re-applies on the next launch/resume under it.
async function resolveTaskEffort(
  taskId: string | undefined,
): Promise<EffortLevel | undefined> {
  if (!taskId) return undefined;
  return (await getTaskEffort(taskId))?.level;
}

export interface CreateConversationOpts {
  runtimeId?: string;
  taskId?: string;
  attemptId?: string;
  prompt?: string;
  /** A family ("opus") or a pinned version; resolved to what runs here, once. */
  model?: ModelChoice;
  spawnedBy?: string;
  kind?: ConversationKind;
  forkFromConversationId?: string;
  /**
   * With `forkFromConversationId`: fork from just BEFORE this user message (its
   * transcript line uuid) instead of from the end. The new conversation resumes
   * a truncated copy of the source's transcript; the source is untouched.
   */
  forkAtMessageUuid?: string;
  /**
   * Where a NEW attempt's conversations run (default: a worktree). A launch
   * onto an existing attempt runs in that attempt's workspace; naming another
   * one throws.
   */
  workspace?: WorkspaceSpec;
}

// The `runtime.create` options a launch spawns with — the spawn job's `create`
// input, and the inline reuse-branch spawn's options.
interface SpawnCreate {
  prompt?: string;
  model: ConversationModel;
  effort?: EffortLevel;
  resumeSessionId?: string;
  forkSession: boolean;
}

// A session file "fork from here" writes: the source transcript cut just before
// the chosen message, relabelled with a fresh session id. It lands in the SAME
// `~/.claude/projects/<dir>/` as the source — both conversations share one
// worktree, and a session resolving to another directory is what the
// foreign-session check refuses.
interface TranscriptCopy {
  destPath: string;
  content: string;
}

// A cut the transcript refuses ("fork from here" on a message that cannot be cut
// at). A client mistake, not a server fault — the create handler answers 409.
export class TranscriptCutError extends Error {
  constructor(
    readonly reason: LocateCutRefusal,
    conversationId: string,
    userMessageUuid: string,
  ) {
    super(
      `Cannot cut conversation ${conversationId} at message ${userMessageUuid}: ${reason}`,
    );
    this.name = "TranscriptCutError";
  }
}

// Everything a conversation launch needs to know, resolved BEFORE any write.
// Produced by `prepareConversation`, consumed by `commitConversation` (the
// writes, on one transaction) and `finishConversation` (what runs after commit).
export interface PreparedConversation {
  runtimeId: string;
  conversationId: string;
  model: ConversationModel;
  spawnedBy: string;
  kind: ConversationKind;
  // The caller's raw prompt, for the `conversationCreated` payload.
  rawPrompt: string | undefined;
  prepromptId: string | undefined;
  // The attempt's workspace: its path and the spec it was launched with.
  workspace: WorkspaceAt;
  create: SpawnCreate;
  target:
    // Reuse an existing attempt's worktree (fork / +Sonnet / fork-session).
    // `transcriptCopy` is the "fork from here" case: a session file to write
    // before the spawn, which `create.resumeSessionId` then plain-resumes.
    | { kind: "reuse"; attemptId: string; transcriptCopy?: TranscriptCopy }
    // Mint a new attempt (and a new task when `taskId` is absent).
    | { kind: "new"; attemptId: string; taskId: string | undefined };
}

// Phase 1 of a launch: READS ONLY. Everything slow or off-DB (fork-source
// lookup, the worktree root, attachment resolution, preprompt/effort lookups)
// happens here, before any transaction is open — so a hang here holds no lock
// and has written nothing.
export async function prepareConversation(
  opts: CreateConversationOpts = {},
): Promise<PreparedConversation> {
  const runtimeId = opts.runtimeId ?? DEFAULT_RUNTIME;
  // Resolve now so an unknown runtime throws before anything is written.
  Runtime.get(runtimeId);
  // An agent that cannot run is refused here, with the fix, before a task,
  // attempt or job exists — not started as a pane that dies on `command not
  // found` or sits at a login prompt (ClaudeCodeUnavailableError).
  await assertClaudeCodeReady();

  // When forking, inherit the source's attempt (same worktree) and claude
  // session id; let the caller still override `model` so the +Sonnet/+Opus
  // buttons work as expected.
  let resumeSessionId: string | undefined;
  let attemptId = opts.attemptId;
  let inheritedModel: ConversationModel | undefined;
  let transcriptCopy: TranscriptCopy | undefined;
  if (opts.forkAtMessageUuid && !opts.forkFromConversationId) {
    throw new Error("forkAtMessageUuid requires forkFromConversationId");
  }
  if (opts.forkFromConversationId) {
    const source = await getConversation(opts.forkFromConversationId);
    if (!source) {
      throw new Error(
        `Source conversation ${opts.forkFromConversationId} not found`,
      );
    }
    if (!source.claudeSessionId) {
      throw new Error(
        `Source conversation ${opts.forkFromConversationId} hasn't started yet — no Claude session id available to fork`,
      );
    }
    if (attemptId && attemptId !== source.attemptId) {
      throw new Error(
        `forkFromConversationId requires attemptId to match the source attempt`,
      );
    }
    attemptId = source.attemptId;
    resumeSessionId = source.claudeSessionId;
    inheritedModel = source.model;

    if (opts.forkAtMessageUuid) {
      // Fork from a chosen message: resume OUR truncated copy rather than let
      // the CLI copy the whole history. Still reads only — the file is written
      // in `finishConversation`, after the row has committed.
      const located = await locateTranscriptCut(
        source.id,
        opts.forkAtMessageUuid,
      );
      if (!located.ok) {
        throw new TranscriptCutError(
          located.reason,
          source.id,
          opts.forkAtMessageUuid,
        );
      }
      const newSessionId = crypto.randomUUID();
      transcriptCopy = {
        destPath: join(dirname(located.path), `${newSessionId}.jsonl`),
        // Every line names its session (`sessionId` / `session_id`); a copy that
        // still named the source would be the source's history under a new
        // filename.
        content: serializeTranscript(
          located.cut.keptLines.map((line) =>
            line.replaceAll(located.sessionId, newSessionId),
          ),
        ),
      };
      resumeSessionId = newSessionId;
    }
  }
  // THE point a model choice becomes the version that runs: a family ("opus")
  // resolves to its current version NOW, at spawn — not when the task was
  // armed. The conversation row records the concrete version it ran; a fork
  // keeps its source's version unless the caller picked one. A pinned version
  // the catalog does not know, or has retired, throws ModelUnavailableError
  // (409) — never a silent substitute.
  const model = requireModel(
    opts.model ?? inheritedModel ?? DEFAULT_MODEL_CHOICE,
    getModelCatalog(),
  );

  // The namespace of the backend doing the creating, unless the caller named
  // one. `runtimeNamespace()` throws rather than answering with a guess, so
  // there is no "no worktree" branch left to write.
  const spawnedBy = opts.spawnedBy ?? runtimeNamespace();

  let workspace: WorkspaceAt;
  let target: PreparedConversation["target"];
  // The task this conversation belongs to, used to resolve a per-task preprompt
  // (baked into the first user turn as a <special_instructions> block). Derived
  // from the existing attempt when reusing a worktree, otherwise the task we
  // launch under — undefined when the commit will create the task, which then
  // has no preprompt or effort of its own yet.
  let effectiveTaskId: string | undefined;

  if (attemptId) {
    const attempt = await getAttemptRow(attemptId);
    if (!attempt) throw new Error(`Unknown attemptId "${attemptId}"`);
    if (opts.workspace && !Bun.deepEquals(opts.workspace, attempt.workspace)) {
      throw new Error(
        `Attempt ${attemptId} runs in workspace ${JSON.stringify(attempt.workspace)}, not ${JSON.stringify(opts.workspace)}`,
      );
    }
    workspace = {
      attemptId,
      path: attempt.worktreePath,
      spec: attempt.workspace,
    };
    effectiveTaskId = attempt.taskId;
    target = { kind: "reuse", attemptId, transcriptCopy };
  } else {
    effectiveTaskId = opts.taskId;
    const newId = attemptIdKind.mint();
    // Validated before anything is written: an unknown scratch profile, or an
    // input its profile refuses, throws here. An explicit workspace wins; else
    // the launching task's own choice (the workspace launch option) — the
    // default worktree when it has none, or when the commit creates the task.
    const spec = parseWorkspaceSpec(
      opts.workspace ??
        (opts.taskId ? await getTaskWorkspace(opts.taskId) : DEFAULT_WORKSPACE),
    );
    // Derived purely from the id, so the path is known before the workspace
    // dir exists. Its `prepare` (for a worktree, the multi-second `git worktree
    // add` checkout) is deferred to the durable `conversations.spawn` job — off
    // the interactive response — and `createAttempt` inserts a row that carries
    // the not-yet-existent path (it is never existence-checked at write time).
    workspace = {
      attemptId: newId,
      path: await Workspace.pathFor(spec.kind, newId),
      spec,
    };
    target = { kind: "new", attemptId: newId, taskId: opts.taskId };
  }

  // Single chokepoint for `![](/api/attachments/<id>)` → `@<disk-path>` rewriting
  // so every entry point (HTTP create, agent launch, auto-start) gets it.
  let resolvedPrompt = opts.prompt
    ? (await resolveAttachmentRefs(opts.prompt)).text
    : undefined;

  // Resolve the preprompt (config list-item id → text). It comes only from the
  // launching task — a launch has no preprompt of its own, so a conversation
  // can never run under one its task does not show. A dangling or empty
  // selection resolves to undefined → nothing is injected.
  const prepromptId = effectiveTaskId
    ? (await getTaskPreprompt(effectiveTaskId))?.prepromptId
    : undefined;
  const preprompt = resolvePreprompt(prepromptId);

  // Bake the preprompt into the FIRST user turn (wrapped in
  // <special_instructions>) so it's durable, visible in the transcript, and
  // replayed verbatim on resume/fork. Only on a fresh launch: a
  // forked/resumed transcript already contains the baked first turn, so
  // re-injecting (`claude --resume --fork-session` copies the original) would
  // duplicate it. The no-initial-prompt edge yields a first turn that is the
  // preprompt block alone.
  if (preprompt && !resumeSessionId) {
    resolvedPrompt = resolvedPrompt
      ? `${wrapPreprompt(preprompt)}\n\n${resolvedPrompt}`
      : wrapPreprompt(preprompt);
  }

  // Thinking mode: the launching task's, for the same reason as the preprompt.
  // Threaded to the runtime as CLI args; no prompt mutation (unlike preprompt,
  // ultracode rides --settings, not the transcript).
  const effort = await resolveTaskEffort(effectiveTaskId);

  return {
    runtimeId,
    conversationId: conversationIdKind.mint(),
    model,
    spawnedBy,
    kind: opts.kind ?? "user",
    rawPrompt: opts.prompt,
    prepromptId,
    workspace,
    target,
    create: {
      prompt: resolvedPrompt,
      model,
      effort,
      resumeSessionId,
      // `--fork-session` asks the CLI to copy the whole history under a new id.
      // A fork at a message already has its own (truncated) copy to resume.
      forkSession: !!opts.forkFromConversationId && !transcriptCopy,
    },
  };
}

// Phase 2 of a launch: WRITES ONLY, every one on `tx`. The task (when there is
// none), the attempt, the durable fork + spawn jobs, the conversation row and
// its `conversationCreated` emit commit together or not at all — a throw, a
// crash or a killed connection anywhere in here leaves no attempt without a
// conversation (no phantom "In progress") and no job for rows that do not
// exist. Run it inside `withTaskStatusBatch` (or `runStatusBatchOn`): the
// status-changing writes assert they are on the batch's tx.
export async function commitConversation(
  tx: DbExecutor,
  p: PreparedConversation,
): Promise<Conversation> {
  // `EmitTx`/`EnqueueTx` name the NodePgDatabase facade; a PgTransaction is
  // structurally that at runtime (same narrow cast as tasks-core's
  // `withTaskStatusChange`).
  const queueTx = tx as EmitTx;

  if (p.target.kind === "new") {
    const { attemptId } = p.target;
    let taskId = p.target.taskId;
    if (!taskId) {
      const task = await createTask(
        { title: "Untitled", author: p.spawnedBy },
        tx,
      );
      await setTaskCategory(
        task.id,
        p.kind === "system" ? "system" : CONVERSATIONS_CATEGORY_ID,
        tx,
      );
      taskId = task.id;
    }
    await createAttempt(
      {
        id: attemptId,
        taskId,
        worktreePath: p.workspace.path,
        workspace: p.workspace.spec,
      },
      tx,
    );
    // The workspace's own writes (a worktree's DB fork job), on this
    // transaction, so they exist iff the attempt does.
    await Workspace.get(p.workspace.spec.kind).onCommit(queueTx, p.workspace);
  }

  const conv = await insertConversation(
    {
      id: p.conversationId,
      attemptId: p.target.attemptId,
      runtime: p.runtimeId,
      model: p.model,
      spawnedBy: p.spawnedBy,
      kind: p.kind,
    },
    tx,
  );

  // Emit right after insert — the subscribers (title-gen, queue-rank, preprompt
  // snapshot) need only the row, never the live session — so it fires whether the
  // spawn happens inline (reuse branch) or in the background job (new branch).
  // On `tx`, so no subscriber job exists for a conversation that rolled back.
  await conversationCreated.emit(
    {
      conversationId: conv.id,
      taskId: conv.taskId,
      model: conv.model,
      spawnedBy: conv.spawnedBy!,
      createdAt: conv.createdAt.toISOString(),
      prompt: p.rawPrompt?.trim() || undefined,
      kind: conv.kind,
      prepromptId: p.prepromptId,
    },
    { tx: queueTx },
  );

  if (p.target.kind === "new") {
    // New-attempt branch: background the workspace's `prepare` (for a
    // worktree, the multi-second `git worktree add`) + `runtime.create` in a
    // durable graphile job so the interactive Launch response returns
    // immediately with a `starting` row. On failure the job records a deduped
    // notification and retries; the status reconciler owns the eventual
    // `starting → gone` transition.
    await spawnConversationJob.enqueue(
      {
        conversationId: p.conversationId,
        attemptId: p.target.attemptId,
        worktreePath: p.workspace.path,
        workspace: p.workspace.spec,
        runtimeId: p.runtimeId,
        create: p.create,
      },
      { tx: queueTx },
    );
  }

  return conv;
}

// Phase 3 of a launch: what runs only once the commit has landed.
export async function finishConversation(
  p: PreparedConversation,
): Promise<void> {
  const workspace = Workspace.get(p.workspace.spec.kind);
  if (p.target.kind === "new") {
    // The workspace's post-commit step (a worktree's config-dir copy).
    // Fire-and-forget, but only after commit: a rolled-back launch leaves
    // nothing behind.
    void runTracked(`conversations:workspace-finish:${workspace.kind}`, () =>
      workspace.onFinish(p.workspace),
    );
    return;
  }

  // Reuse-attempt branch (fork / +Sonnet / fork-session): the workspace already
  // exists and the only spawn step (`runtime.create`) is sub-second, so keep it
  // synchronous — no job-pickup latency for the interactive fork buttons.
  try {
    if (p.target.transcriptCopy) {
      await Bun.write(
        p.target.transcriptCopy.destPath,
        p.target.transcriptCopy.content,
      );
    }
    await Runtime.get(p.runtimeId).create(
      p.conversationId,
      p.workspace.path,
      workspace.launch(p.workspace, { conversationId: p.conversationId }),
      p.create,
    );
  } catch (err) {
    // Without this, the row stays at "starting" forever — the status reconciler
    // leaves starting rows alone while they have no pane, and the UI just shows "Starting…" with a terminal pane
    // that prints "can't find session" because tmux never created one.
    // eslint-disable-next-line promise-safety/no-bare-catch
    await updateConversation(p.conversationId, {
      status: "gone",
      endedAt: new Date(),
    }).catch((e) => {
      console.error(
        `[conversations] failed to mark ${p.conversationId} gone after runtime.create error`,
        e,
      );
    });
    throw err;
  }
}

// prepare (reads) → commit (one transaction) → finish (post-commit effects).
export async function createConversation(
  opts: CreateConversationOpts = {},
): Promise<Conversation> {
  const prepared = await prepareConversation(opts);
  const conv = await withTaskStatusBatch((tx) =>
    commitConversation(tx, prepared),
  );
  await finishConversation(prepared);
  return conv;
}

export async function deleteConversation(id: string): Promise<void> {
  const row = await getConversationRuntime(id);
  const runtimeId = row?.runtime ?? DEFAULT_RUNTIME;
  await Runtime.get(runtimeId).delete(id);
}

// Thrown by the resume paths that map onto a request/response (the toolbar
// Resume button). The transparent hibernation path returns the same information
// as a `ResumeOutcome` instead — same check, two shapes, one definition.
export class ResumeBlockedError extends Error {
  constructor(
    readonly reason: ResumeBlockedReason,
    message: string,
  ) {
    super(message);
    this.name = "ResumeBlockedError";
  }
}

// The workspace a conversation runs in: its attempt's.
function workspaceOf(row: Conversation): Promise<WorkspaceAt> {
  return workspaceOfAttempt(row.attemptId);
}

// A new attempt's spec, as its kind validates and stores it.
function parseWorkspaceSpec(spec: WorkspaceSpec): WorkspaceSpec {
  return Workspace.get(spec.kind).parseSpec(spec);
}

// Everything that must be true before a conversation can be handed to
// `claude --resume`. Side-effect free ON PURPOSE (it reads, and at most asks
// Claude Code again whether it is signed in): a refusal has to leave the
// conversation byte-for-byte as it was, so this runs before the stale pane is
// killed and before any status is written.
//
// The workspace check is the load-bearing one: a resume into a workspace that
// is gone starts the agent somewhere else (see each kind's `checkResumable`).
async function preflightResume(
  row: Conversation,
  workspace: WorkspaceAt,
): Promise<{ kind: "ok" } | ResumeBlocked> {
  if (!row.claudeSessionId) {
    return {
      kind: "blocked",
      reason: "no-session",
      message: `Conversation ${row.id} has no saved Claude session to resume.`,
    };
  }
  const resumable = Workspace.get(workspace.spec.kind).checkResumable(
    workspace,
  );
  if (resumable.kind === "missing") {
    return {
      kind: "blocked",
      reason: "workspace-missing",
      message: resumable.message,
    };
  }
  // Last: the only check that may start a process (a re-probe when the last
  // answer is not a recent `ready`).
  const claude = await checkClaudeCode();
  if (claude.kind !== "ready") {
    return {
      kind: "blocked",
      reason: "claude-code-unavailable",
      message: claudeCodeBlockMessage(claude),
    };
  }
  return { kind: "ok" };
}

// Shared resume mechanics: clear the stale (dead) pane, reset the row to
// "starting" so the status reconciler tracks the new session (and the
// STARTING_TIMEOUT safety net, applied by the status sweep, catches a failed
// resume → gone), and spawn a fresh `claude --resume`
// pane. Does NOT touch task hold/drop or the hibernation flag — callers own those.
//
// Re-runs `preflightResume` as the invariant guard rather than trusting callers:
// every statement below is destructive (kills the pane, rewrites status), so the
// check must sit at the mutation, not one frame above it.
async function respawnResume(row: Conversation): Promise<void> {
  const workspace = await workspaceOf(row);
  const preflight = await preflightResume(row, workspace);
  if (preflight.kind === "blocked") {
    throw new ResumeBlockedError(preflight.reason, preflight.message);
  }

  const runtime = Runtime.get(row.runtime);
  // tmux refuses `new-session -s <name>` when a (dead) session by that name
  // still exists. Clear any stale pane before re-spawning.
  await runtime.delete(row.id);

  // Reset status so the status reconciler can track the new session. Without this,
  // "done" rows are skipped and the conversation stays stuck as done.
  await updateConversation(row.id, { status: "starting", endedAt: null });

  await runtime.create(
    row.id,
    workspace.path,
    Workspace.get(workspace.spec.kind).launch(workspace, {
      conversationId: row.id,
    }),
    {
      resumeSessionId: row.claudeSessionId!,
      model: row.model,
      effort: await resolveTaskEffort(row.taskId),
    },
  );

  // A turn held while this conversation was last `starting` (a launch that
  // never came up, then went `gone`) is delivered now that a session runs
  // again. The flip out of the `starting` set above enqueues the flush too;
  // dedup folds the two.
  await deliverHeldTurnsJob.enqueue({ conversationId: row.id });
}

export async function resumeConversation(id: string): Promise<Conversation> {
  const row = await getConversation(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  if (row.status !== "gone" && row.status !== "done") {
    throw new Error(`Cannot resume conversation ${id} (status: ${row.status})`);
  }

  // Refuse before `respawnResume` touches anything, so a blocked resume leaves
  // the conversation exactly where the user left it. (`respawnResume` asserts
  // the same invariant; this call is what turns it into a clean 409 with an
  // actionable message rather than a generic failure.)
  const preflight = await preflightResume(row, await workspaceOf(row));
  if (preflight.kind === "blocked") {
    throw new ResumeBlockedError(preflight.reason, preflight.message);
  }

  await respawnResume(row);

  await updateTask(row.taskId, { drop: false, hold: false });

  return (await getConversation(id)) as Conversation;
}

// Idempotent transparent restore for a hibernated conversation. No-op unless the
// row is actually hibernated (process intentionally absent). On resume it reuses
// the exact proven resume path, then clears the hibernation flag. Status stays
// `waiting`-class to the user (the brief "starting" is invisible — the transcript
// renders from disk). The chokepoint before any live-process interaction
// (viewed/select endpoint, submitTurn).
//
// Returns a `ResumeOutcome` rather than throwing on a blocked resume: this fires
// on every conversation open, so its failure arm has to be something the caller
// can render. A blocked outcome deliberately leaves BOTH `status` and
// `hibernatedAt` untouched — the conversation stays a normal hibernated,
// still-active entry in the user's list. Losing track of a conversation because
// its checkout was reclaimed would be a worse bug than the one being reported.
export async function ensureResumed(id: string): Promise<ResumeOutcome> {
  const row = await getConversation(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  if (!row.hibernatedAt) return { kind: "not-hibernated" };

  const preflight = await preflightResume(row, await workspaceOf(row));
  if (preflight.kind === "blocked") return preflight;

  await respawnResume(row);
  await setConversationHibernated(id, null);
  return { kind: "resumed" };
}

const REWIND_REFUSAL_MESSAGE: Record<LocateCutRefusal | "not-in-tail", string> =
  {
    "no-transcript": "This conversation has no transcript on disk to rewind.",
    "not-found": "That message is no longer in the transcript.",
    "not-a-live-user-prompt":
      "A conversation can only be rewound to one of your own messages.",
    "nothing-before":
      "This is the first message — there is nothing before it to go back to. Start a new conversation instead.",
    "not-in-tail":
      "This message predates a fork, so the conversation cannot be rewound to it in place. Fork from it instead.",
  };

function refuseRewind(reason: LocateCutRefusal | "not-in-tail") {
  return {
    ok: false as const,
    reason,
    message: REWIND_REFUSAL_MESSAGE[reason],
  };
}

export async function previewRewind(
  id: string,
  userMessageUuid: string,
): Promise<RewindPreview> {
  const row = await getConversation(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  const located = await locateTranscriptCut(id, userMessageUuid);
  if (!located.ok) return refuseRewind(located.reason);
  return {
    ok: true,
    messageText: located.cut.messageText,
    losses: located.cut.losses,
    inPlace: located.isTail,
    turnRunning: row.status === "working",
  };
}

/**
 * "Rewind to here": continue THIS conversation from just before one of the
 * user's messages, handing that message's text back for the prompt editor.
 *
 * The CLI's own `/rewind` lives behind an interactive menu, and its
 * `--resume-session-at` flag is honoured in print mode only — so instead of
 * driving either, this restarts the process on a shorter transcript. The CLI
 * sees an ordinary `claude --resume` of the same session id, which is why the
 * session chain, the CLI's file checkpoints and the prompt cache (the kept
 * history is byte-identical) all carry over untouched. Design and the
 * experiments behind it: `research/2026-09-18-conversations-rewind-conversation.md`.
 *
 * `backupPath` receives the full original transcript. The file is MOVED there,
 * not copied, and a fresh file takes its place: the running CLI holds the old
 * file open, so anything it still appends on its way down follows the moved
 * file instead of landing after the cut. That is also why it must be on the
 * same filesystem as `~/.claude` — a cross-device rename throws, before anything
 * has been changed.
 *
 * Everything that can refuse runs first, and reads only.
 */
export async function rewindConversationAt(
  id: string,
  userMessageUuid: string,
  backupPath: string,
): Promise<RewindOutcome> {
  const row = await getConversation(id);
  if (!row) throw new Error(`Conversation ${id} not found`);

  const preflight = await preflightResume(row, await workspaceOf(row));
  if (preflight.kind === "blocked") {
    return { ok: false, reason: preflight.reason, message: preflight.message };
  }
  const located = await locateTranscriptCut(id, userMessageUuid);
  if (!located.ok) return refuseRewind(located.reason);
  if (!located.isTail) return refuseRewind("not-in-tail");

  // The user is continuing this conversation, not closing it: a close requested
  // earlier must not turn the pane restart below into "pane gone → done".
  await updateConversation(id, { closeRequested: false });

  await rename(located.path, backupPath);
  await Bun.write(located.path, serializeTranscript(located.cut.keptLines));

  // Kills the pane — a running turn and any background work with it — and
  // resumes the same session id on the shortened file.
  await respawnResume(row);
  await setConversationHibernated(id, null);
  // Rewinding a closed conversation re-opens it, exactly like the Resume button.
  if (row.status === "gone" || row.status === "done") {
    await updateTask(row.taskId, { drop: false, hold: false });
  }

  return { ok: true, rewindText: located.cut.messageText };
}
