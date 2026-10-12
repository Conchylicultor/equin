import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { resolveClaudeBin } from "@plugins/infra/plugins/paths/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  claudeCodeBlockMessage,
  claudeCodeStatus,
  type ClaudeCodeBlock,
  type ClaudeCodeStatus,
} from "../../core";
import { probeClaudeCode } from "./probe";

/**
 * How long a `ready` answer is trusted by the launch gate before it asks again.
 * A signed-in CLI can sign out on its own (a token expires, the user runs
 * `claude auth logout` elsewhere) and nothing announces it, so a launch that
 * finds an old `ready` re-probes: one Node process per launch at most every
 * five minutes. A NOT-ready answer is never trusted — see {@link checkClaudeCode}.
 */
const READY_MAX_AGE_MS = 5 * 60_000;

interface Checked {
  status: ClaudeCodeStatus;
  at: number;
}

let last: Checked | null = null;
let inflight: Promise<ClaudeCodeStatus> | null = null;
const readyListeners = new Set<() => void>();
const probedListeners = new Set<(status: ClaudeCodeStatus) => void>();

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
  const before = last?.status;
  last = { status, at: Date.now() };
  for (const fn of probedListeners) fn(status);
  if (before !== undefined && JSON.stringify(before) === JSON.stringify(status))
    return;
  claudeCodeStatusServed.notify();
  // Only a real transition wakes the listeners: the first answer after boot has
  // nothing to catch up on (whatever runs at boot asked for itself).
  if (
    before !== undefined &&
    before.kind !== "ready" &&
    status.kind === "ready"
  ) {
    for (const fn of readyListeners) fn();
  }
}

// External, not DB-backed: the truth is a CLI on the host, which no change feed
// observes, so `record` calls its `notify()`. Pushed (the `liveValue` default):
// one small value, the same for every tab, read by the always-mounted health
// dot.
export const claudeCodeStatusServed = serveValue(claudeCodeStatus, {
  source: "external",
  changes: "notified",
  loader: () => (last ? Promise.resolve(last.status) : probe()),
});

/**
 * Claude Code's status, fresh enough to act on: a `ready` answer younger than
 * {@link READY_MAX_AGE_MS} is reused; anything else is probed again. So a user
 * who just signed in from a terminal is never refused by a stale `signed-out`,
 * and a normal launch costs nothing extra.
 */
export async function checkClaudeCode(): Promise<ClaudeCodeStatus> {
  if (
    last &&
    last.status.kind === "ready" &&
    Date.now() - last.at < READY_MAX_AGE_MS
  ) {
    return last.status;
  }
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
 * again, changed or not. The seam for whoever keys work off the installed CLI
 * itself (a version this code has not seen yet) without this plugin knowing
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

/**
 * The Claude Code executable to start, looked up now. The ONLY way to get it:
 * a missing CLI throws {@link ClaudeCodeUnavailableError} here, at the spawn
 * site, instead of being handed on as a bare `claude` that fails as `command
 * not found` inside a pane nobody reads. Also re-probes, since the status the
 * app shows is now known to be out of date.
 */
export function requireClaudeBin(): string {
  const bin = resolveClaudeBin();
  if (bin.kind === "found") return bin.path;
  noteClaudeCodeFailure();
  throw new ClaudeCodeUnavailableError({
    kind: "missing",
    searched: bin.searched,
  });
}
