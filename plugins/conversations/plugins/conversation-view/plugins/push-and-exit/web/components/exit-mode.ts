import {
  standingOf,
  type AttemptWork,
} from "@plugins/tasks/plugins/attempt-work/core";
import type { ConversationStatus } from "@plugins/tasks/plugins/tasks-core/core";
import {
  satisfiesCapabilities,
  type WorkspaceKindState,
} from "@plugins/conversations/plugins/workspace/core";
import type {
  CombinedResources,
  ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";

export type Mode =
  | "send"
  | "queue"
  | "push-and-exit"
  | "exit"
  | "exit-error"
  | "drop-and-exit"
  | "go"
  | "restore"
  | "stop";

/**
 * The `useCombinedResources({ work, hasSibling, files })` result. Imported
 * type-only, so the derivation (and its test) stay pure — no React, no
 * live-state runtime. (`standingOf` is a pure function over the payload, so
 * importing it costs nothing at runtime.)
 *
 * Three structural echoes of the readiness/value gate:
 * - Three states, never two: `loading` (nothing known yet), `error` (one of
 *   the reads failed — the combine's precedence is error > loading > ready), and
 *   `ready`, whose value is one the server currently vouches for.
 * - `files` is the edited-files `Resolvable` payload (spelled structurally to
 *   keep the live-state import out): the loader returns a first-class
 *   "no trustworthy worktree" non-value instead of lying with `[]`.
 * - `work` is the attempt-standing `Resolvable`, in the same shape and for the
 *   same reason. It replaces what used to be a `pushes` array, and that swap is
 *   the whole point of this file: an empty array of push rows was read as proof
 *   that the attempt had pushed nothing, but those rows are written by a
 *   background ingest job that can lag arbitrarily far behind git. "No rows
 *   ingested yet" and "nothing was pushed" were the same value, so a
 *   conversation whose branch was already merged into `main` was offered the
 *   destructive "Drop & Close" as fact. The standing is now measured from git,
 *   and it arrives either measured or as an explicit non-value — there is no
 *   array here whose emptiness can be misread.
 */
export type ExitDecision = CombinedResources<{
  work: ResourceResult<
    { resolved: true; value: AttemptWork } | { resolved: false; reason: string }
  >;
  hasSibling: ResourceResult<boolean>;
  files: ResourceResult<
    | { resolved: true; value: readonly { path: string }[] }
    | { resolved: false; reason: string }
  >;
}>;

export type ExitModeInput = {
  conversation: { attemptId: string } | null;
  live: { status: ConversationStatus } | null;
  draftEmpty: boolean;
  /**
   * The conversation's workspace. Restore / Send / Queue / Stop need none of
   * git, so they are offered in every workspace; only the Push-vs-Drop exit
   * decision reads git, and a workspace without it (scratch) just closes.
   */
  workspace: WorkspaceKindState;
  exitDecision: ExitDecision;
};

/**
 * Whether the exit decision's git reads apply to this workspace: `unknown`
 * while the workspace kind is still loading. The button skips those reads
 * unless this is `yes`, so they never run against a workspace with no git.
 */
export function exitDecisionUsesGit(
  workspace: WorkspaceKindState,
): "yes" | "no" | "unknown" {
  if (!workspace.known) return "unknown";
  return satisfiesCapabilities(workspace.kind, ["git"]) ? "yes" : "no";
}

/**
 * The button's whole decision, as a pure function. `provisional` means "we do
 * not know yet" — the caller renders the mode disabled.
 */
export function deriveExitMode({
  conversation,
  live,
  draftEmpty,
  workspace,
  exitDecision,
}: ExitModeInput): { mode: Mode; provisional: boolean } {
  if (!conversation || !live) return { mode: "exit", provisional: false };
  if (live.status === "gone" || live.status === "done")
    return { mode: "restore", provisional: false };
  // A draft while the agent is working is queued (pasted without a C-c
  // interrupt) rather than sent immediately — surface that as "Queue".
  if (!draftEmpty)
    return {
      mode: live.status === "working" ? "queue" : "send",
      provisional: false,
    };
  if (live.status === "working") return { mode: "stop", provisional: false };
  // No git (a scratch workspace): nothing to push or drop, so closing is the
  // whole decision.
  switch (exitDecisionUsesGit(workspace)) {
    case "unknown":
      return { mode: "exit", provisional: true };
    case "no":
      return { mode: "exit", provisional: false };
    case "yes":
      break;
  }
  // Still loading ⇒ neutral provisional Close. Any of the three resources
  // FAILING makes the decision undecidable, so the mode is a generic,
  // non-destructive, still-clickable "Close (state unknown)" — never the
  // destructive default on a failure, and never stuck provisional (disabled)
  // on a read that will not load.
  if (exitDecision.status === "loading")
    return { mode: "exit", provisional: true };
  if (exitDecision.status === "error")
    return { mode: "exit-error", provisional: false };
  const { work, hasSibling, files } = exitDecision.data;
  // The edited-file set is a `Resolvable`: the loader returns a first-class
  // "no trustworthy worktree" non-value rather than lying with `[]`. An
  // unresolved set is as undecidable as an errored resource — surface the same
  // non-destructive "Close (state unknown)" BEFORE `files.value.length` is even
  // expressible, so the destructive "Drop & Close" default is unreachable by
  // construction, not by a remembered guard.
  if (!files.resolved) return { mode: "exit-error", provisional: false };
  if (files.value.length > 0) {
    if (files.value.every((f) => f.path.startsWith("research/")))
      return { mode: "go", provisional: false };
    return { mode: "push-and-exit", provisional: false };
  }
  // The standing is only consulted once the worktree is known to be clean. That
  // order is deliberate: uncommitted edits already decide the mode above, so an
  // unmeasurable standing degrades only the cases that actually depend on it,
  // rather than turning every dirty worktree into "Close (state unknown)".
  if (!work.resolved) return { mode: "exit-error", provisional: false };
  // Exhaustive on purpose, with no `default`: a future standing arm becomes a
  // tsc error here instead of quietly falling into one of these branches. Note
  // what is NOT written anywhere below — no count compared to zero. The
  // destructive "Drop & Close" is now reachable only from a `"none"` that git
  // measured, never from an absence of knowledge.
  switch (standingOf(work.value)) {
    // Committed but never pushed: the worktree is clean, yet real commits sit on
    // the branch ahead of `main`. This used to read as droppable.
    case "pending":
      return { mode: "push-and-exit", provisional: false };
    // Already merged into `main` (or corroborated by a push row). Closing is the
    // only correct action; dropping the task would discard landed work.
    case "landed":
      return { mode: "exit", provisional: false };
    // Nothing at stake, measured. An active sibling in the same worktree still
    // means the task is in use, so only a lone dead-end attempt offers the drop.
    case "none":
      return {
        mode: hasSibling ? "exit" : "drop-and-exit",
        provisional: false,
      };
  }
}
