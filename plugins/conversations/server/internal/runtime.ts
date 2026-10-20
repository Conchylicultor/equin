import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
import type { EffortLevel } from "@plugins/conversations/plugins/effort-provider/core";
import { getConversationRuntime } from "@plugins/tasks/plugins/tasks-core/server";
import type { LaunchFragment } from "@plugins/conversations/plugins/workspace/server";
import { resolveConversationTranscriptPaths } from "@plugins/conversations/plugins/transcript-watcher/server";
import { readTurnsFromChain, type Turn } from "./claude-transcript";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import type { ConversationRuntimeId } from "@plugins/conversations/plugins/runtime-catalog/core";

export type { Turn };

export interface RuntimeInfo {
  working: boolean;
  dead: boolean;
  claudeSessionId: string | null;
  /**
   * When the agent's event `working` rests on was written, or null when the
   * verdict does not rest on one (a dead agent, no event yet). A turn the
   * ledger confirmed submitting AFTER this makes the session working whatever
   * the write said — see `liveStatusFor`.
   */
  statusWrittenAt: Date | null;
}

/**
 * A runtime's push signal: "the live state of these conversations may have
 * moved". Only a wake-up — the reconciler re-reads the truth through
 * {@link ConversationRuntime.inspect} and the DB, so a duplicate, late or
 * spurious signal lands on the same answer.
 *
 * - `conversationIds` — the runtime knows exactly whose state moved.
 * - `all` — the runtime lost track (its watcher dropped events); reconcile
 *   everything.
 */
export type RuntimeSignal = { conversationIds: string[] } | { all: true };

/**
 * The runtime's verdict on a sent turn: `submitted` — the agent took it;
 * `unverified` — the runtime cannot tell, so only the agent's own report
 * (the turn ledger's confirmation) can say whether the turn went in.
 */
export type SubmitVerdict =
  { kind: "submitted" } | { kind: "unverified"; reason: string };

/** What sending one turn did. */
export interface TypedTurn {
  verdict: SubmitVerdict;
}

export interface ConversationRuntime {
  /** One of the closed list `CONVERSATION_RUNTIMES` (conversations core). */
  readonly id: ConversationRuntimeId;
  /**
   * Start a session in `cwd` (the attempt's workspace). `launch` is the
   * workspace's addition to the CLI launch — typed launch options (setting
   * sources, MCP servers) the runtime renders its own way, and a settings
   * fragment it merges into its own; the runtime knows nothing else about the
   * workspace.
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
   * Send `text` to the session as one user turn. Resolves with the runtime's
   * verdict; throws only when the text provably never reached the agent.
   */
  send(conversationId: string, text: string): Promise<TypedTurn>;
  interrupt(conversationId: string): Promise<void>;
  /**
   * Stop the running turn: interrupt it and, when it got no reply, take it back
   * out of the session — the transcript no longer holds it and nothing of it is
   * left for the next turn to ride on. Resolves with the text taken back, which
   * the web hands back to the composer, or null when the turn stays (it had a
   * reply, or there was none). Runs as the conversation's terminal writer.
   */
  stop(conversationId: string): Promise<{ returnedText: string | null }>;
  /**
   * Reply to an open question (AskUserQuestion) with `text` instead of an
   * answer, as ONE operation: dismiss the question, then send `text` as a
   * normal turn — exactly as {@link send}. Implementers MUST NOT send while the
   * question is still open: the agent would read the text as its answer.
   */
  answerPrompt(conversationId: string, text: string): Promise<TypedTurn>;
  /**
   * Wait, bounded, until the session can take a turn — for a session that was
   * just started, until the agent answers. Resolves
   * `"timeout"` (never throws for it) when the bound or `signal` elapses first,
   * so the caller decides what an agent that never became ready means. Used to
   * deliver turns held while the conversation was starting (turns.ts).
   */
  waitUntilReady(
    conversationId: string,
    signal: AbortSignal,
  ): Promise<"ready" | "timeout">;
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

// One writer per agent. Everything that drives an agent — a turn, an answer,
// an interrupt, Stop — runs here, so two of them never interleave (a Stop's
// relaunch racing a turn into the old process). In-process is enough: the HTTP
// handlers and the jobs that send (the held-turn flush, the spawn's launch)
// run in the same backend process.
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

export async function waitUntilReady(
  id: string,
  signal: AbortSignal,
): Promise<"ready" | "timeout"> {
  const row = await getConversationRuntime(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  return Runtime.get(row.runtime).waitUntilReady(id, signal);
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
