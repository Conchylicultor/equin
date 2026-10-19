export type AllowVerdict = { kind: "allow" };
export type DenyVerdict = { kind: "deny"; reason: string; fatal?: boolean };
/**
 * Let the call through, but hand the model a fact it was missing. The arm for a
 * guard that has an *answer* rather than an objection — blocking there would be
 * a false positive, and staying silent leaves the model to keep guessing.
 */
export type InformVerdict = { kind: "inform"; context: string };
/**
 * Let the call through with some of its input replaced — for a guard whose fix
 * is mechanical and changes nothing the agent meant, so denying and asking for
 * a retype would only cost a turn.
 *
 * A PATCH, not the new input: Claude Code's `updatedInput` replaces the tool
 * input wholesale, and a guard's input type names only the fields it reads. The
 * runner merges the patch over the full payload, so the fields a guard never
 * declared (`description`, `timeout`, …) cannot be dropped by one.
 *
 * It does not approve the call: the rewritten input still goes through the
 * normal permission flow.
 */
export type RewriteVerdict = {
  kind: "rewrite";
  patch: Readonly<Record<string, unknown>>;
};
export type Verdict =
  AllowVerdict | DenyVerdict | InformVerdict | RewriteVerdict;

/**
 * The session transcript, or the reason there isn't one.
 *
 * A discriminated result rather than `string | undefined`, because the two
 * outcomes lead to opposite verdicts: "the harness has not reported that task
 * finished" is grounds to block a wait, "I could not look" is not. An absent
 * transcript read as empty text is indistinguishable from a transcript that
 * mentions nothing, which is exactly the confusion this type removes.
 */
export type TranscriptRead =
  { kind: "read"; text: string } | { kind: "unavailable"; why: string };

export type ToolMatcher =
  "Bash" | "Write" | "Edit" | "Read" | "NotebookEdit" | "Agent";

export interface GuardContext {
  cwd: string;
  /**
   * The Claude Code session this tool call belongs to, straight off the
   * PreToolUse payload. Guards that carry state across calls key it on this.
   */
  sessionId: string;
  /**
   * Absolute directories OUTSIDE any checkout that an agent may still write
   * into — host-global user content whose home is a `defineDataDir`
   * declaration, not the repo (today: the prototypes tree).
   *
   * Supplied by the hook ENTRY POINT (`bin/guard.ts`) rather than read here,
   * and this is the whole point of the field. A data dir's absolute path is
   * only reachable from its owner's `data-dirs/index.ts`, which the boundary
   * rules keep out of `core/` — so a guard that wanted to name one had no
   * choice but to hardcode `~/.singularity/…`, and that literal would go
   * silently wrong the next time the data root moves (it already has once, in
   * the `apps/` layout migration). Passing the RESOLVED paths in means the
   * guard compares against wherever the declaration says the directory is
   * today, including under a `SINGULARITY_DIR` override.
   */
  writableDataDirs: readonly string[];
  /**
   * This session's transcript as the harness has written it so far — the only
   * record of what the harness has TOLD the agent, which is where a background
   * task's completion notification lives.
   *
   * A capability, not the `transcript_path` string off the payload. A guard
   * holding the path would have to remember that the field can be missing, that
   * the file can be huge, and that a failed read must not read as "the harness
   * said nothing" — the mistake that made every look at a finished task's
   * output count as a poll. Reading is lazy: callers ask only once a rule has
   * already tripped, so the common path pays nothing.
   */
  readTranscript(): TranscriptRead;
  /**
   * The subagent this call came from, or `null` for the main conversation.
   *
   * A discriminated `null` rather than a `fromSubagent: boolean` plus loose id
   * fields: a guard that branches on this almost always wants to NAME the agent
   * (the stop hook keys its ownership ledger on the id), and two independent
   * optional fields could disagree about whether there is an agent at all.
   *
   * Computed once here, because "is `agent_id` present" is the whole of the
   * test and re-deriving it per guard is how one of them ends up reading
   * `agent_type` instead — which is also set for a `--agent` main session.
   */
  agent: { id: string; type: string } | null;
  /**
   * The id of the tool call being judged, straight off the PreToolUse payload —
   * the same id the transcript pairs the call's result by. `null` when the
   * payload carries none (a replay, a test). A guard that hands it to the
   * command lets what the command leaves behind be shown under that call.
   */
  toolUseId: string | null;
  hasBypass(token: string): boolean;
  allow(): AllowVerdict;
  deny(reason: string): DenyVerdict;
  fatal(reason: string): DenyVerdict;
  inform(context: string): InformVerdict;
  rewrite(patch: Readonly<Record<string, unknown>>): RewriteVerdict;
}

export interface BashInput {
  command?: string;
  /**
   * Set by the caller to detach the command. Only a tool-level background run
   * is tracked by the harness and notifies on exit — a shell-level `&` is not.
   */
  run_in_background?: boolean;
  /**
   * Milliseconds. In the foreground, the kill deadline (capped at 600 000). With
   * `run_in_background`, how long the background task may live before the
   * harness stops it — 1 800 000 when omitted, 7 200 000 at most.
   */
  timeout?: number;
}
export interface FileInput {
  file_path?: string;
}
export interface AgentInput {
  model?: string;
  subagent_type?: string;
}

export interface Guard<I = unknown> {
  name: string;
  matcher: ToolMatcher | ToolMatcher[];
  /** File at the worktree root whose presence lets this guard's calls through. */
  bypassToken?: string;
  /**
   * Tell each agent (the main conversation, every subagent) this guard's
   * `inform` at most once per session — for a long message, such as a whole
   * guide, that would otherwise repeat on every call.
   */
  once?: boolean;
  check(input: I, ctx: GuardContext): Verdict | Promise<Verdict>;
}
