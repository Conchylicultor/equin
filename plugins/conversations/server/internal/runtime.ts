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
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";

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
  /**
   * When the CLI itself wrote the status `working` rests on, or null when the
   * verdict does not rest on the CLI's write (a dead pane, a menu on screen, no
   * session file). A turn the CLI confirmed submitting AFTER this makes the
   * session working whatever the write said — see `liveStatusFor`.
   */
  statusWrittenAt: Date | null;
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

/**
 * The submit check's verdict on a typed turn: `submitted` — the box emptied
 * after Enter; `unverified` — it never did (or the box could not be read), so
 * only the CLI's own report can say whether the turn went in.
 */
export type SubmitVerdict =
  { kind: "submitted" } | { kind: "unverified"; reason: string };

/** What typing one turn found and did. */
export interface TypedTurn {
  /**
   * The draft the box held before typing, cleared first — `""` when it was
   * empty, `null` when the box could not be read.
   */
  cleared: string | null;
  verdict: SubmitVerdict;
}

/**
 * The input box still held text after it was cleared and the bound ran out.
 * Nothing was typed: typing now would submit that text and the turn as one
 * prompt.
 */
export class InputNotEmptyError extends Error {
  constructor(
    readonly conversationId: string,
    readonly draft: string,
  ) {
    super(
      `The input box of ${conversationId} still holds text after clearing it; ` +
        "refusing to type after it",
    );
    this.name = "InputNotEmptyError";
  }
}

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
  /**
   * Type `text` into the session's input box and submit it. Implementers MUST
   * leave the box empty before typing — clear any draft and verify it is gone
   * ({@link clearInput}), throwing {@link InputNotEmptyError} when it will not
   * empty — because the CLI submits whatever the box holds plus the typed text
   * as ONE prompt. Resolves with what was cleared and the submit check's
   * verdict; throws only when the text provably never reached the box.
   */
  send(conversationId: string, text: string): Promise<TypedTurn>;
  /**
   * Empty the input box and verify it is empty; throws
   * {@link InputNotEmptyError} when it still holds text after the bound.
   * `awaitRestore` first waits (bounded) for a draft to APPEAR — the CLI puts a
   * turn interrupted before its reply back into the box asynchronously, and
   * Stop must clear that copy, not race it. Resolves with the draft it cleared
   * (`""` when there was none, `null` when the box could not be read).
   */
  clearInput(
    conversationId: string,
    opts?: { awaitRestore?: boolean },
  ): Promise<string | null>;
  interrupt(conversationId: string): Promise<void>;
  /**
   * Answer a pending interactive prompt form (e.g. AskUserQuestion) by
   * sending `text` as a turn. This is a single ATOMIC operation:
   *   1. dismiss the active prompt form,
   *   2. WAIT until the form has actually cleared,
   *   3. send `text` as a normal turn — into a box verified empty, exactly
   *      as {@link send}.
   *
   * The wait in step 2 is load-bearing and the whole reason this is a
   * dedicated runtime method rather than a back-to-back interrupt()+send():
   * dismissing the form is not instantaneous, and if the still-live form is
   * fed the keystrokes it auto-selects a wrong option and fabricates an
   * answer (losing the user's text). Implementers MUST verify the form has
   * cleared before sending, and MUST throw if it never clears rather than
   * sending into a live form.
   */
  answerPrompt(conversationId: string, text: string): Promise<TypedTurn>;
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
   * deliver turns held while the conversation was starting (turns.ts).
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

// One writer per terminal. Everything that sends keys to an agent's pane —
// a turn, an answer, an interrupt, Stop, a menu answer — runs here, so two of
// them can never interleave their keystrokes into one input box (two sends
// raced into one concatenated prompt). In-process is enough: the HTTP handlers
// and the jobs that type (the held-turn flush, the spawn's launch) run in the
// same backend process.
const terminals = createKeyedMutex();

/** Run `fn` as the conversation's only terminal writer. */
export function withTerminal<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return terminals.run(id, fn);
}

/** The conversation's runtime row and runtime; throws when it does not exist. */
export async function conversationRuntime(id: string): Promise<{
  waitingFor: string | null;
  runtime: ConversationRuntime;
}> {
  const row = await getConversationRuntime(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  return { waitingFor: row.waitingFor, runtime: Runtime.get(row.runtime) };
}

export async function interruptConversation(id: string): Promise<void> {
  await withTerminal(id, async () => {
    await (await conversationRuntime(id)).runtime.interrupt(id);
  });
}

export async function flushInteractivePrompt(id: string): Promise<void> {
  await withTerminal(id, async () => {
    await (await conversationRuntime(id)).runtime.flushInteractivePrompt(id);
  });
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
  await withTerminal(id, async () => {
    await (await conversationRuntime(id)).runtime.answerMenu(id, choice);
  });
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
