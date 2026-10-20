import {
  standingOf,
  type AttemptWork,
} from "@plugins/tasks/plugins/attempt-work/core";
import type {
  ConversationStatus,
  ConversationWorkingOn,
} from "@plugins/tasks/plugins/tasks-core/core";
import { isTurnRunning } from "@plugins/conversations/core";
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
  | "exit-unavailable"
  | "drop-and-exit"
  | "go"
  | "restore"
  | "stop";

/** The attempt-standing payload: measured, or an explicit non-value. */
type WorkPayload =
  { resolved: true; value: AttemptWork } | { resolved: false; reason: string };

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
  work: ResourceResult<WorkPayload>;
  hasSibling: ResourceResult<boolean>;
  files: ResourceResult<
    | { resolved: true; value: readonly { path: string }[] }
    | { resolved: false; reason: string }
  >;
}>;

/**
 * The exit decision of a workspace with no git (scratch): no edited files to
 * read, only the attempt's standing — which, there, is its recorded delivery.
 */
export type NoGitExitDecision = CombinedResources<{
  work: ResourceResult<WorkPayload>;
  hasSibling: ResourceResult<boolean>;
}>;

/**
 * Which exit reads apply, by the conversation's workspace. Restore / Send /
 * Queue / Stop need none of them, so they are offered in every workspace; only
 * the exit decision differs: a git workspace weighs its edited files and branch,
 * one without git only its delivery. `unavailable`: the attempt's standing is
 * measured from git, which a host without the computer (the in-browser demo)
 * cannot read — the decision cannot be made, so only the safe Close is offered,
 * with `message` saying why.
 */
export type ExitReads =
  | { workspace: "unknown" }
  | { workspace: "unavailable"; message: string }
  | { workspace: "git"; decision: ExitDecision }
  | { workspace: "no-git"; decision: NoGitExitDecision };

export type ExitModeInput = {
  conversation: { attemptId: string } | null;
  live: {
    status: ConversationStatus;
    workingOn: ConversationWorkingOn | null;
  } | null;
  draftEmpty: boolean;
  exit: ExitReads;
};

/**
 * Whether the conversation's workspace has git: `unknown` while its kind is
 * still loading. The button skips the edited-files read unless this is `git`,
 * so it never runs against a workspace with no git.
 */
export function exitWorkspace(
  workspace: WorkspaceKindState,
): "unknown" | "git" | "no-git" {
  if (!workspace.known) return "unknown";
  return satisfiesCapabilities(workspace.kind, ["git"]) ? "git" : "no-git";
}

type ModeResult = { mode: Mode; provisional: boolean };

/**
 * The button's whole decision, as a pure function. `provisional` means "we do
 * not know yet" — the caller renders the mode disabled.
 */
export function deriveExitMode({
  conversation,
  live,
  draftEmpty,
  exit,
}: ExitModeInput): ModeResult {
  if (!conversation || !live) return { mode: "exit", provisional: false };
  if (live.status === "gone" || live.status === "done")
    return { mode: "restore", provisional: false };
  // A draft while a turn runs is queued behind it rather than sent
  // immediately — surface that as "Queue". Between turns (even with background
  // work pending) it is sent, and there is no turn for Stop to interrupt.
  const turnRunning = isTurnRunning(live);
  if (!draftEmpty)
    return { mode: turnRunning ? "queue" : "send", provisional: false };
  if (turnRunning) return { mode: "stop", provisional: false };
  switch (exit.workspace) {
    case "unknown":
      return { mode: "exit", provisional: true };
    case "unavailable":
      return { mode: "exit-unavailable", provisional: false };
    case "git": {
      const d = exit.decision;
      if (d.status !== "ready") return unsettled(d.status);
      const { work, hasSibling, files } = d.data;
      // The edited-file set is a `Resolvable`: the loader returns a first-class
      // "no trustworthy worktree" non-value rather than lying with `[]`. An
      // unresolved set is as undecidable as an errored resource — surface the
      // same non-destructive "Close (state unknown)" BEFORE
      // `files.value.length` is even expressible, so the destructive "Drop &
      // Close" default is unreachable by construction, not by a remembered guard.
      if (!files.resolved) return { mode: "exit-error", provisional: false };
      if (files.value.length > 0) {
        if (files.value.every((f) => f.path.startsWith("research/")))
          return { mode: "go", provisional: false };
        return { mode: "push-and-exit", provisional: false };
      }
      // The standing is only consulted once the worktree is known to be clean.
      // That order is deliberate: uncommitted edits already decide the mode
      // above, so an unmeasurable standing degrades only the cases that
      // actually depend on it, rather than turning every dirty worktree into
      // "Close (state unknown)".
      return fromStanding(work, hasSibling);
    }
    // No git, so nothing to push: the standing (its delivery) alone decides
    // Close vs Drop & Close — a scratch task closed without delivering must
    // drop, or it would stay `attempted` forever.
    case "no-git": {
      const d = exit.decision;
      if (d.status !== "ready") return unsettled(d.status);
      return fromStanding(d.data.work, d.data.hasSibling);
    }
  }
}

// Still loading ⇒ neutral provisional Close. Any of the resources FAILING makes
// the decision undecidable, so the mode is a generic, non-destructive,
// still-clickable "Close (state unknown)" — never the destructive default on a
// failure, and never stuck provisional (disabled) on a read that will not load.
function unsettled(status: "loading" | "error"): ModeResult {
  return status === "loading"
    ? { mode: "exit", provisional: true }
    : { mode: "exit-error", provisional: false };
}

function fromStanding(work: WorkPayload, hasSibling: boolean): ModeResult {
  if (!work.resolved) return { mode: "exit-error", provisional: false };
  // Exhaustive on purpose, with no `default`: a future standing arm becomes a
  // tsc error here instead of quietly falling into one of these branches. Note
  // what is NOT written anywhere below — no count compared to zero. The
  // destructive "Drop & Close" is now reachable only from a `"none"` that was
  // measured, never from an absence of knowledge.
  switch (standingOf(work.value)) {
    // Committed but never pushed: the worktree is clean, yet real commits sit on
    // the branch ahead of `main`. This used to read as droppable.
    case "pending":
      return { mode: "push-and-exit", provisional: false };
    // Already merged into `main` (or corroborated by a push row, or a scratch
    // attempt's recorded delivery). Closing is the only correct action;
    // dropping the task would discard landed work.
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
