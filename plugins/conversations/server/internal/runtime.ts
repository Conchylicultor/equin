import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
import type { EffortLevel } from "@plugins/conversations/plugins/effort-provider/core";
import { getConversationRuntime } from "@plugins/tasks/plugins/tasks-core/server";
import type { TerminalMenu } from "@plugins/conversations/plugins/terminal-menu/core";
import type { LaunchFragment } from "@plugins/conversations/plugins/workspace/server";
import { resolveConversationTranscriptPaths } from "@plugins/conversations/plugins/transcript-watcher/server";
import {
  readTurnsFromChain,
  rewindLastUserTurn,
  type Turn,
} from "./claude-transcript";
import { ensureResumed, ResumeBlockedError } from "./lifecycle";
import { QUESTION_WAITING_FOR } from "../../core/turn-gate";
import { releaseQuestionHolds } from "./question-hold";

export type { Turn };

export interface RuntimeInfo {
  title: string;
  working: boolean;
  dead: boolean;
  claudeSessionId: string | null;
  worktreePath: string;
  waitingFor: string | null;
  /**
   * The numbered menu open on the session's screen, other than the question
   * menu (which has its own flow and reads as `waitingFor: "question"`). While
   * one is open the reconciler records it and the session waits on it.
   */
  menu: TerminalMenu | null;
}

/**
 * Which way to answer an open terminal menu: an option, named by its number
 * AND its label so a menu that changed since the user saw it is refused rather
 * than answered with whatever now sits at that number — or cancel it.
 */
export type TerminalMenuChoice =
  { kind: "option"; n: number; label: string } | { kind: "cancel" };

/**
 * A runtime's push signal: "the live state of these conversations may have
 * moved". Only a wake-up — the reconciler re-reads the truth through
 * {@link ConversationRuntime.inspect} and the DB, so a duplicate, late or
 * spurious signal lands on the same answer.
 *
 * - `conversationIds` — the runtime knows exactly whose state moved.
 * - `worktreeName` — something moved for every conversation running in this
 *   worktree (named by its directory's last path segment, the namespace an op
 *   marker is keyed on), and the runtime cannot tell which one.
 * - `all` — the runtime lost track (its watcher dropped events); reconcile
 *   everything.
 */
export type RuntimeSignal =
  { conversationIds: string[] } | { worktreeName: string } | { all: true };

export interface ConversationRuntime {
  readonly id: string;
  /**
   * Start a session in `cwd` (the attempt's workspace). `launch` is the
   * workspace's addition to the CLI launch — appended argv and a settings
   * fragment the runtime merges into its own; the runtime knows nothing else
   * about the workspace.
   */
  create(
    conversationId: string,
    cwd: string,
    launch: LaunchFragment,
    opts?: {
      prompt?: string;
      model?: ConversationModel;
      effort?: EffortLevel;
      resumeSessionId?: string;
      forkSession?: boolean;
    },
  ): Promise<void>;
  delete(conversationId: string): Promise<void>;
  /**
   * True if a live session/process for this conversation currently exists.
   * Makes {@link create} idempotent under durable-job retry: a retry after a
   * crash between spawning the session and committing the job must not throw on
   * the duplicate session — `create` probes this first and no-ops when true.
   */
  isRunning(conversationId: string): Promise<boolean>;
  /** Every live session this runtime hosts. Throws when the state is unknown. */
  list(): Promise<Map<string, RuntimeInfo>>;
  /**
   * The batched form of {@link list} for a known set: the live state of each of
   * `ids`. A missing id means no live session; a throw means the state is
   * unknown (the same contract as `list()` failing) — never an empty map.
   */
  inspect(ids: readonly string[]): Promise<Map<string, RuntimeInfo>>;
  /**
   * Start delivering push signals (see {@link RuntimeSignal}). Resolves once the
   * runtime's signal sources are open — a source that cannot open rejects, so a
   * runtime that would leave its conversations' status frozen fails loudly at
   * boot. Resolves to the unsubscribe.
   */
  subscribe(onSignal: (signal: RuntimeSignal) => void): Promise<() => void>;
  send(conversationId: string, text: string): Promise<void>;
  interrupt(conversationId: string): Promise<void>;
  /**
   * Answer a pending interactive prompt form (e.g. AskUserQuestion) by
   * sending `text` as a turn. This is a single ATOMIC operation:
   *   1. dismiss the active prompt form,
   *   2. WAIT until the form has actually cleared,
   *   3. send `text` as a normal turn.
   *
   * The wait in step 2 is load-bearing and the whole reason this is a
   * dedicated runtime method rather than a back-to-back interrupt()+send():
   * dismissing the form is not instantaneous, and if the still-live form is
   * fed the keystrokes it auto-selects a wrong option and fabricates an
   * answer (losing the user's text). Implementers MUST verify the form has
   * cleared before sending, and MUST throw if it never clears rather than
   * sending into a live form.
   */
  answerPrompt(conversationId: string, text: string): Promise<void>;
  /**
   * Dismiss a pending interactive prompt form (e.g. AskUserQuestion) WITHOUT
   * sending any answer. Cancelling the form forces the CLI to flush the
   * buffered assistant `tool_use` to the JSONL transcript so the web UI can
   * render it; the user can then answer from the web form (which goes through
   * {@link answerPrompt}). Implementers MUST verify the form has cleared and
   * MUST throw if it never clears, exactly like {@link answerPrompt}'s
   * dismissal step — they share the same self-healing Escape loop, this method
   * simply stops after the form clears (no answer is sent).
   */
  flushInteractivePrompt(conversationId: string): Promise<void>;
  /**
   * Wait, bounded, until the session can take a typed turn — for a session that
   * was just started, until the agent has drawn its input box. Resolves
   * `"timeout"` (never throws for it) when the bound or `signal` elapses first,
   * so the caller decides what an agent that never became ready means. Used to
   * deliver turns held while the conversation was starting (held-turns.ts).
   */
  waitUntilReady(
    conversationId: string,
    signal: AbortSignal,
  ): Promise<"ready" | "timeout">;
  /**
   * Answer the terminal menu reported as {@link RuntimeInfo.menu}. Implementers
   * MUST re-read the menu first and throw unless it is still open and, for an
   * option, still offers that label at that number — a key sent into a changed
   * menu, or into an idle prompt, picks something the user never chose. Resolves
   * once the menu has left the screen; throws if it never does.
   */
  answerMenu(conversationId: string, choice: TerminalMenuChoice): Promise<void>;
}

const registry = new Map<string, ConversationRuntime>();

export const Runtime = {
  /**
   * Returns a {@link Registration} token. The actual `registry.set` (and the
   * duplicate-id guard) fire when the framework invokes `.register()` during
   * the plugin register phase. Plugins list the result in their `register`
   * array on `ServerPluginDefinition`.
   */
  define(runtime: ConversationRuntime): Registration {
    return {
      register() {
        if (registry.has(runtime.id)) {
          throw new Error(`Runtime "${runtime.id}" already registered`);
        }
        registry.set(runtime.id, runtime);
      },
    };
  },
  get(id: string): ConversationRuntime {
    const runtime = registry.get(id);
    if (!runtime) throw new Error(`Unknown runtime "${id}"`);
    return runtime;
  },
  all(): ConversationRuntime[] {
    return Array.from(registry.values());
  },
};

export async function sendTurn(id: string, text: string): Promise<void> {
  // A queued/meta-prompt turn must never be sent into a dead pane: if the
  // conversation is hibernated, transparently resume it (`claude --resume`)
  // before sending. No-op for live conversations.
  //
  // A blocked resume must abort the send. Falling through would type the turn
  // into whatever pane happens to answer to this id — including, when the
  // worktree checkout is gone, one that tmux silently started in $HOME.
  const resumed = await ensureResumed(id);
  if (resumed.kind === "blocked") {
    throw new ResumeBlockedError(resumed.reason, resumed.message);
  }
  const row = await getConversationRuntime(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  const runtime = Runtime.get(row.runtime);
  // A turn sent while a question waits skips the question: the user chose to
  // say something else. Typed into the live menu, it would pick an option and
  // fabricate an answer instead. So the question is dismissed first, as Escape
  // in the terminal would — a held one is handed back to the CLI, which draws
  // its menu — and the turn goes in its place (answerPrompt waits for that menu,
  // Escapes it and types the turn once the input is idle again).
  if (row.waitingFor === QUESTION_WAITING_FOR) {
    await releaseQuestionHolds([id]);
    await runtime.answerPrompt(id, text);
    return;
  }
  await runtime.send(id, text);
}

export async function interruptConversation(id: string): Promise<void> {
  const row = await getConversationRuntime(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  await Runtime.get(row.runtime).interrupt(id);
}

export async function answerPrompt(id: string, text: string): Promise<void> {
  const row = await getConversationRuntime(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  await Runtime.get(row.runtime).answerPrompt(id, text);
}

export async function flushInteractivePrompt(id: string): Promise<void> {
  const row = await getConversationRuntime(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  await Runtime.get(row.runtime).flushInteractivePrompt(id);
}

export async function waitUntilReady(
  id: string,
  signal: AbortSignal,
): Promise<"ready" | "timeout"> {
  const row = await getConversationRuntime(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  return Runtime.get(row.runtime).waitUntilReady(id, signal);
}

export async function answerTerminalMenu(
  id: string,
  choice: TerminalMenuChoice,
): Promise<void> {
  const row = await getConversationRuntime(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  await Runtime.get(row.runtime).answerMenu(id, choice);
}

export async function getConversationRow(id: string): Promise<{
  status: string;
  runtime: string;
  claudeSessionId: string | null;
} | null> {
  return getConversationRuntime(id);
}

export async function readConversationTurns(
  id: string,
  since?: string,
): Promise<Turn[]> {
  return readTurnsFromChain(
    await resolveConversationTranscriptPaths(id),
    since,
  );
}

export async function rewindConversationTurn(
  id: string,
): Promise<string | null> {
  const paths = await resolveConversationTranscriptPaths(id);
  // The LIVE TAIL ONLY. `rewindLastUserTurn` truncates the file it is handed, and
  // the Stop button calls this on every stopped turn; truncating an ancestor would
  // destroy the history the merged read path now depends on. An empty chain means
  // there is no transcript to rewind.
  const tail = paths.at(-1);
  if (!tail) return null;
  return rewindLastUserTurn(tail);
}
