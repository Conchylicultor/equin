import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import {
  claudeCodeBlockMessage,
  type ClaudeCodeBlock,
  type ClaudeCodeStatus,
} from "../../core";
import { probeClaudeCode } from "./probe";

/** The last probe's answer; null until the first lands. */
let last: ClaudeCodeStatus | null = null;
let inflight: Promise<ClaudeCodeStatus> | null = null;
const readyListeners = new Set<() => void>();
const probedListeners = new Set<(status: ClaudeCodeStatus) => void>();
const changedListeners = new Set<() => void>();

/**
 * Probe now, sharing a probe already running: concurrent askers (a burst of
 * launches, the resource loader, a recheck) wait on one pair of processes.
 */
function probe(): Promise<ClaudeCodeStatus> {
  inflight ??= (async () => {
    try {
      const status = await probeClaudeCode();
      record(status);
      return status;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function record(status: ClaudeCodeStatus): void {
  const before = last;
  last = status;
  for (const fn of probedListeners) fn(status);
  if (before !== null && JSON.stringify(before) === JSON.stringify(status))
    return;
  for (const fn of changedListeners) fn();
  // Only a real transition wakes the listeners: the first answer after boot has
  // nothing to catch up on (whatever runs at boot asked for itself).
  if (before !== null && before.kind !== "ready" && status.kind === "ready") {
    for (const fn of readyListeners) fn();
  }
}

/**
 * The last answer, probing first if there is none yet — what the
 * claude-code-status live value (served by this plugin's machine half) loads.
 */
export function currentClaudeCodeStatus(): Promise<ClaudeCodeStatus> {
  return last ? Promise.resolve(last) : probe();
}

/**
 * Run `fn` whenever a probe's answer differs from the last one — the live
 * value's `notify`. Returns the unsubscribe.
 */
export function onClaudeCodeStatusChanged(fn: () => void): () => void {
  changedListeners.add(fn);
  return () => {
    changedListeners.delete(fn);
  };
}

/**
 * Claude Code's status for a launch to act on: a `ready` answer is reused,
 * whatever its age; anything else (none yet, signed out, unreadable) is probed
 * again, so a user who just signed in is never refused by a stale block.
 *
 * Why an old `ready` is enough: the probe reads one `initialize` answer, and
 * every agent's own Claude Code answers the same `initialize` seconds later,
 * on the launch's path (the launch waits for it) — an agent that finds itself
 * signed out ends before `ready`, failing its launch with
 * {@link claudeCodeBlockMessage}, and the failure re-probes
 * ({@link noteClaudeCodeFailure}) so the next launch is refused up front.
 * Probing again here would start a second Claude Code (1–4 s) on the user's
 * critical path to ask what the agent is about to answer anyway.
 */
export async function checkClaudeCode(): Promise<ClaudeCodeStatus> {
  if (last?.kind === "ready") return last;
  return probe();
}

/** Probe now, whatever the last answer was ("Check again"). */
export function recheckClaudeCodeNow(): Promise<ClaudeCodeStatus> {
  return probe();
}

/**
 * Something that needed Claude Code just failed: what we last knew is older
 * than that evidence. Re-probe in the background so the health row catches up.
 */
export function noteClaudeCodeFailure(): void {
  // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- a re-probe the failing caller must not wait on; its result is pushed through the resource
  void probe();
}

/**
 * Run `fn` whenever Claude Code turns `ready` after having been blocked — the
 * cue for work that waited on it (armed auto-start tasks) to go again.
 * Returns the unsubscribe.
 */
export function onClaudeCodeReady(fn: () => void): () => void {
  readyListeners.add(fn);
  return () => readyListeners.delete(fn);
}

/**
 * Run `fn` with every fresh probe's answer — each time the machine was asked
 * again, changed or not. The seam for whoever keys work off the Claude Code
 * build itself (a version this code has not seen yet) without this plugin knowing
 * them. Returns the unsubscribe.
 */
export function onClaudeCodeProbed(
  fn: (status: ClaudeCodeStatus) => void,
): () => void {
  probedListeners.add(fn);
  return () => probedListeners.delete(fn);
}

/**
 * Thrown where an agent was about to start and Claude Code cannot run one.
 *
 * An `HttpError(409)`, so every endpoint that lets it propagate answers with
 * the message and its fix — no launch surface has to know about it.
 */
export class ClaudeCodeUnavailableError extends HttpError {
  constructor(readonly block: ClaudeCodeBlock) {
    super(409, claudeCodeBlockMessage(block));
    this.name = "ClaudeCodeUnavailableError";
  }
}

/**
 * Refuse, before anything is written, to start an agent that cannot run.
 * The call every launch and resume path makes up front.
 */
export async function assertClaudeCodeReady(): Promise<void> {
  const status = await checkClaudeCode();
  if (status.kind !== "ready") throw new ClaudeCodeUnavailableError(status);
}
