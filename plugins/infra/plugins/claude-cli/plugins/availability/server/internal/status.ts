import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { SYSTEM_ACCOUNT_ID } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import { activeClaudeAccountId } from "@plugins/infra/plugins/claude-cli/plugins/accounts/server";
import {
  claudeCodeBlockMessage,
  type ClaudeCodeBlock,
  type ClaudeCodeStatus,
} from "../../core";
import { probeClaudeCode } from "./probe";

/** The last probe's answer; null until the first lands. */
let last: ClaudeCodeStatus | null = null;
/**
 * Claude refused the computer's credential mid-turn
 * ({@link noteClaudeCodeSignInRefused}). The probe cannot see it — its
 * `initialize` only says a credential is present — so a `ready` probe reads
 * `sign-in-refused` until the user signs in again or asks to check again
 * ({@link recheckClaudeCodeNow}).
 */
let refused = false;
/**
 * One probe at a time. Through `createInflight`, not a hand-held promise: a
 * caller that joins a probe another caller started (a launch's, a recheck's,
 * another tab's read) waits on Claude Code processes it is not running, so it
 * gives back its read-admit slot for the wait. A plain `await` of a shared
 * promise keeps the slot for the whole probe (1–5 s on a busy host).
 */
const probes = createInflight("claude-code-probe");
const readyListeners = new Set<() => void>();
const probedListeners = new Set<(status: ClaudeCodeStatus) => void>();
const changedListeners = new Set<() => void>();

/**
 * Probe now, sharing a probe already running: concurrent askers (a burst of
 * launches, the resource loader, a recheck) wait on one pair of processes.
 */
function probe(): Promise<ClaudeCodeStatus> {
  return probes.run("probe", async () => {
    const status = withRefusal(await probeClaudeCode());
    record(status);
    return status;
  });
}

function withRefusal(probed: ClaudeCodeStatus): ClaudeCodeStatus {
  return refused && probed.kind === "ready"
    ? { kind: "sign-in-refused", version: probed.version }
    : probed;
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

/** Whether an agent launched now can start, and if not, why. */
export type LaunchReadiness =
  { kind: "ready" } | { kind: "blocked"; block: ClaudeCodeBlock };

/**
 * Can an agent launched now start? It runs on the active Claude account, so
 * that is the account asked about:
 *
 * - the computer's own login (the system account): its Claude Code status,
 *   {@link checkClaudeCode};
 * - an added account (a plan token or an API key): ready. It brings its own
 *   credential, handed to Claude Code in the agent's environment with every
 *   other one removed — the computer's login plays no part, so the computer
 *   being signed out must not hold it back. Nothing is probed: Claude Code's
 *   `initialize` only says a credential is present, never whether it works.
 *   The agent's own start is the check — a credential Claude Code refuses
 *   ends the agent before `ready`, failing the launch loudly with the reason.
 *
 * With auto-switch on, the runtime may start the agent on another account
 * than the active one; that account's own start checks it the same way.
 */
export async function checkLaunchReadiness(): Promise<LaunchReadiness> {
  if ((await activeClaudeAccountId()) !== SYSTEM_ACCOUNT_ID)
    return { kind: "ready" };
  const status = await checkClaudeCode();
  return status.kind === "ready"
    ? { kind: "ready" }
    : { kind: "blocked", block: status };
}

/** The active account the last {@link noteActiveAccountChanged} saw; null before the first. */
let lastActive: string | null = null;

/**
 * The accounts file was rewritten: when another account than before is now
 * active and it brings its own credential, launches held back by the
 * computer's sign-in can run — wake {@link onClaudeCodeReady}'s listeners.
 * The first call only records the active account: nothing was switched.
 */
export async function noteActiveAccountChanged(): Promise<void> {
  const active = await activeClaudeAccountId();
  const before = lastActive;
  lastActive = active;
  if (before === null || before === active) return;
  if (active !== SYSTEM_ACCOUNT_ID) for (const fn of readyListeners) fn();
}

/**
 * Probe now, whatever the last answer was — the user's own Check again, or a
 * sign-in that just finished. Either is the user saying the login changed, so
 * a refusal Claude gave earlier ({@link noteClaudeCodeSignInRefused}) is
 * dropped: if the login is still refused, the next agent's turn says so again.
 */
export function recheckClaudeCodeNow(): Promise<ClaudeCodeStatus> {
  refused = false;
  return probe();
}

/**
 * Probe now, keeping a refusal — the user came back to the window while
 * Claude Code is blocked ({@link recheckClaudeCodeNow} is their explicit ask).
 * A sign-in noticed this way (signed out → ready) is seen; a refused login is
 * not mistaken for a fixed one.
 */
export function recheckClaudeCodeOnReturn(): Promise<ClaudeCodeStatus> {
  return probe();
}

/**
 * Claude refused the computer's sign-in: an agent on the computer's own login
 * (the system account) had a turn fail with `authentication_failed` — an
 * expired or revoked login. Claude Code reads `sign-in-refused` at once (the
 * health row, every launch control's fix, the launch gate) instead of the
 * `ready` its probe would keep answering.
 */
export function noteClaudeCodeSignInRefused(): void {
  refused = true;
  if (last?.kind === "ready")
    record({ kind: "sign-in-refused", version: last.version });
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
 * Run `fn` whenever a launch that was blocked can run again — the cue for work
 * that waited on it (armed auto-start tasks) to go again: the computer's
 * Claude Code turned `ready` after a block, or the active account became one
 * that brings its own credential ({@link noteActiveAccountChanged}).
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
 * Refuse, before anything is written, to start an agent that cannot run on
 * the account it launches on ({@link checkLaunchReadiness}). The call every
 * launch and resume path makes up front.
 */
export async function assertClaudeCodeReady(): Promise<void> {
  const launch = await checkLaunchReadiness();
  if (launch.kind === "blocked")
    throw new ClaudeCodeUnavailableError(launch.block);
}
