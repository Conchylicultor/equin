import { readdir, readFile, stat } from "node:fs/promises";
import { CLAUDE_SESSIONS_DIR } from "@plugins/infra/plugins/paths/server";
import {
  recordReportDebounced,
  DEFAULT_REPORT_DEBOUNCE_MS,
} from "@plugins/reports/server";
import { subtreePids, type ProcessTree } from "./process-tree";

const SESSIONS_DIR = CLAUDE_SESSIONS_DIR;

// Claude CLI session status values (undocumented internal state from
// ~/.claude/sessions/<pid>.json). Exhaustive as of CLI v2.1.141.
// Hard error on unknown values so new CLI statuses surface immediately — but
// only for the record we actually adopt (see `readSessionState`).
type CliSessionStatus = "busy" | "idle" | "shell" | "waiting";

const KNOWN_STATUSES = new Set<CliSessionStatus>([
  "busy",
  "idle",
  "shell",
  "waiting",
]);

// A predicate rather than a cast at the call site: the narrowing belongs to the
// allow-list that defines it, so adding a status to the set is the only edit a
// new CLI status ever needs.
function isKnownStatus(value: string): value is CliSessionStatus {
  return (KNOWN_STATUSES as ReadonlySet<string>).has(value);
}

// `kind` as written by the CLI. Unlike `status` this is a *secondary* filter —
// it only ever excludes a candidate — so an unrecognised value is reported and
// then treated as "not a background host", never thrown on. A throw here would
// blank every pane hosting a process from a newer CLI, which is precisely the
// class of self-inflicted blackout this module exists to prevent.
const KNOWN_KINDS = new Set<string>(["bg", "interactive"]);

// The CLI stamps `tmux` as `#{session_name}:#{window_id}.#{pane_id}`, e.g.
// "conv-1787129489-vnbm:@3466.%3466". Only the trailing `%pane_id` is compared:
// `session_name` and `window_id` are mutable (`rename-session`, `break-pane`,
// `move-window`) while `#{pane_id}` is fixed for the pane's whole life.
const TMUX_STAMP_RE = /^(.+):(@\d+)\.(%\d+)$/;

/** A sessions file's `tmux` stamp, split into its three tmux identities. */
export interface TmuxStamp {
  /** `#{session_name}` — the conversation id for a pane this runtime made. Mutable. */
  sessionName: string;
  /** `#{window_id}`, e.g. "@3466". Mutable. */
  windowId: string;
  /** `#{pane_id}`, e.g. "%3466" — fixed for the pane's whole life. */
  paneId: string;
}

/**
 * Parse a sessions file's `tmux` stamp. **Throws** on a value that does not
 * have the `#{session_name}:#{window_id}.#{pane_id}` shape: the stamp is the
 * whole basis of tier-1 ownership, so a format change must be loud on the first
 * file that hits it rather than silently demoting the fleet to tier 2.
 */
export function parseTmuxStamp(stamp: string, file: string): TmuxStamp {
  const match = TMUX_STAMP_RE.exec(stamp);
  if (match == null) {
    throw new Error(
      `Unrecognised tmux stamp "${stamp}" in ${file} — ` +
        `expected #{session_name}:#{window_id}.#{pane_id}`,
    );
  }
  return { sessionName: match[1]!, windowId: match[2]!, paneId: match[3]! };
}

/**
 * Whose state a changed sessions file is about, for routing a push signal —
 * never for deciding that state (ownership stays `resolveSessionState`'s, over
 * the process tree). The stamp's `session_name` names the conversation directly;
 * a record with no stamp (a legacy CLI, a relocated child) names only the
 * directory it runs in, the same fallback tier 2 uses.
 */
export type SessionFileRoute =
  | { kind: "session"; sessionName: string }
  | { kind: "cwd"; cwd: string }
  | { kind: "none" };

export function routeSessionFile(raw: string, file: string): SessionFileRoute {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const stamp = readString(parsed.tmux);
  if (stamp != null) {
    return {
      kind: "session",
      sessionName: parseTmuxStamp(stamp, file).sessionName,
    };
  }
  const cwd = readString(parsed.cwd);
  return cwd != null ? { kind: "cwd", cwd } : { kind: "none" };
}

export interface SessionState {
  sessionId: string | null;
  status: CliSessionStatus | null;
  waitingFor: string | null;
  /** When the CLI wrote `status` (epoch ms), or null when it did not say. */
  statusUpdatedAt: number | null;
}

/**
 * The pane we are resolving for, as three facts a session record can be matched
 * against: where to look (`panePid`), what a record must name to claim us
 * (`paneId`), and which worktree "local to this pane" means (`worktreePath`).
 */
export interface PaneRef {
  /** `#{pane_pid}` — the root of the process subtree we search. */
  panePid: number;
  /** `#{pane_id}`, e.g. "%3429" — immutable, so it is the identity we match on. */
  paneId: string;
  /** `#{pane_start_path}` — the directory a tier-2 record's `cwd` must equal. */
  worktreePath: string;
}

/**
 * Something in the subtree that we could not turn into an answer, or that the
 * answer had to overrule. None of these are failures of resolution — resolution
 * still returns its best value — they are the evidence trail that makes a wrong
 * or missing session id investigable instead of merely visible.
 *
 * - `unclaimed-subtree-session` — the subtree named sessions, none claimed the
 *   pane. This is the alarm for every residual shape the claim rule refuses to
 *   guess at; without it "nothing claimed" would be silently empty.
 * - `foreign-session-outranked` — a rejected record was fresher than the winner,
 *   i.e. the old freshest-wins rule would have adopted somebody else's session
 *   here. A live counter of how often that used to happen.
 * - `cwd-mismatch` — the record we adopted runs in a different directory from
 *   the pane. Not fatal (a parked pointer is authoritative), but worth knowing.
 * - `stale-job-host-file` — a sessions file claims a `jobId` but its pid is not
 *   in the process snapshot: a leaked file from a job host that has exited.
 * - `unknown-session-kind` — a `kind` value the CLI has introduced since.
 */
export type SessionAnomalyKind =
  | "unclaimed-subtree-session"
  | "foreign-session-outranked"
  | "cwd-mismatch"
  | "stale-job-host-file"
  | "unknown-session-kind";

export interface SessionAnomaly {
  kind: SessionAnomalyKind;
  /** The pane the anomaly was observed while resolving. */
  paneId: string;
  message: string;
  detail: Record<string, unknown>;
}

/**
 * One `~/.claude/sessions/<pid>.json`, reduced to the fields that decide
 * *whose* session it is. Deliberately excludes `status` / `waitingFor`: those
 * are read from `raw` for the winner alone (see `readSessionState`), so an
 * unrecognised status in some stranger's file cannot throw for this pane.
 */
interface SessionIdentity {
  pid: number;
  /** The parsed file, kept so the adopted record's status can be read later. */
  raw: Record<string, unknown>;
  sessionId: string;
  /** `%pane_id` from the `tmux` stamp, or null when the file carries no stamp. */
  stampedPaneId: string | null;
  cwd: string | null;
  kind: string | null;
  /** Set on the stub left behind in the pane when its session was parked. */
  parkedJobId: string | null;
  /** Set on the background job's own file — the other end of `parkedJobId`. */
  jobId: string | null;
}

/** How a subtree record relates to the pane it was found under. */
type ClaimTier = "self" | "local" | "rejected";

// Not an absorbed failure: the sessions file legitimately does not exist yet
// when a reconcile runs before Claude has written ~/.claude/sessions/<pid>.json.
// Every caller re-resolves on the next reconcile, so this must stay a value, not a throw.
const NULL_STATE: SessionState = {
  sessionId: null,
  status: null,
  waitingFor: null,
  statusUpdatedAt: null,
};

/** Session-file IO, injectable so resolution is testable without a real /proc. */
export interface SessionFileDeps {
  /** Raw file contents, or null when the pid has no sessions file (ENOENT). */
  readSessionFile: (pid: number) => Promise<string | null>;
  /** File mtime in epoch ms, or null when the pid has no sessions file (ENOENT). */
  statSessionFile: (pid: number) => Promise<number | null>;
  /**
   * Every pid that has a sessions file right now — the search space for a
   * parked job's host, which by definition lives OUTSIDE the pane's subtree.
   * Only read when a parked pointer is actually present, so the directory
   * listing costs nothing on the 22-of-23 panes that never park.
   */
  listSessionPids: () => Promise<number[]>;
  /** Where the evidence trail goes. Never throws — resolution must not depend on it. */
  reportAnomaly: (anomaly: SessionAnomaly) => void;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

const defaultDeps: SessionFileDeps = {
  async readSessionFile(pid) {
    try {
      return await readFile(`${SESSIONS_DIR}/${pid}.json`, "utf8");
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  },
  async statSessionFile(pid) {
    try {
      return (await stat(`${SESSIONS_DIR}/${pid}.json`)).mtimeMs;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  },
  async listSessionPids() {
    // No ENOENT guard: this only ever runs after a sessions file in this very
    // directory was read, so a missing directory here is a real failure.
    const pids: number[] = [];
    for (const name of await readdir(SESSIONS_DIR)) {
      const match = /^(\d+)\.json$/.exec(name);
      if (match) pids.push(Number(match[1]));
    }
    return pids;
  },
  reportAnomaly(anomaly) {
    // Same channel tmux-runtime already uses for a failed resolution: one
    // deduped row per (pane, anomaly), counted rather than re-filed.
    //
    // Debounced because this runs on every reconcile of the pane — each
    // working/waiting transition, the minute sweep, and (while it lives) the
    // 1 s status shadow audit on main — while the conditions it reports are
    // PERSISTENT, not transient: a machine-wide daemon lending a spare into this
    // pane's subtree stays true for as long as that spare lives. Undebounced, one
    // such spare upserts a report row on every reconcile indefinitely and the
    // row's `count` measures reconciles. The key is (anomaly kind, pane, message), and the
    // message is what carries the identity of the specific problem — which
    // foreign session outranked which claimant, which pid claims a dead job —
    // so two different strangers on one pane stay two signals.
    recordReportDebounced(
      `claude-session ${anomaly.kind} ${anomaly.paneId} ${anomaly.message}`,
      DEFAULT_REPORT_DEBOUNCE_MS,
      {
        kind: "crash",
        source: "server-caught",
        message: `claude-session ${anomaly.kind} for pane ${anomaly.paneId}: ${anomaly.message}`,
        data: {
          errorType: "SessionClaimAnomaly",
          label: `claude-session.${anomaly.kind}`,
          anomaly: anomaly.kind,
          paneId: anomaly.paneId,
          ...anomaly.detail,
        },
      },
    );
  },
};

/** A present, non-empty string field, or null. */
function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The identity half of one sessions file, or null when the file names no
 * session (a file that names no session can never be an answer).
 *
 * A `tmux` value we cannot parse **throws**. The stamp is the whole basis of
 * tier 1, so a format change must be loud on the first pane that hits it —
 * degrading to "no stamp" would silently demote the entire fleet to tier 2,
 * where a pane whose `cwd` no longer matches simply goes blank.
 */
function parseIdentity(
  raw: string,
  pid: number,
  pane: PaneRef,
  deps: SessionFileDeps,
): SessionIdentity | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const sessionId = readString(parsed.sessionId);
  if (sessionId == null) return null;

  const stamp = readString(parsed.tmux);
  let stampedPaneId: string | null = null;
  if (stamp != null) {
    stampedPaneId = parseTmuxStamp(stamp, `${SESSIONS_DIR}/${pid}.json`).paneId;
  }

  const kind = readString(parsed.kind);
  if (kind != null && !KNOWN_KINDS.has(kind)) {
    deps.reportAnomaly({
      kind: "unknown-session-kind",
      paneId: pane.paneId,
      message: `session file ${pid}.json declares kind "${kind}"`,
      detail: { pid, sessionId, sessionKind: kind },
    });
  }

  return {
    pid,
    raw: parsed,
    sessionId,
    stampedPaneId,
    cwd: readString(parsed.cwd),
    kind,
    parkedJobId: readString(parsed.parkedJobId),
    jobId: readString(parsed.jobId),
  };
}

/**
 * The live-session fields, read from the one record we actually adopted.
 *
 * Split out from `parseIdentity` on purpose: parsing `status` while *scanning*
 * meant one background process running a newer CLI — a process that belongs to
 * a different conversation entirely — could throw and blank the hosting pane.
 */
function readSessionState(identity: SessionIdentity): SessionState {
  const { raw } = identity;
  let status: CliSessionStatus | null = null;
  if (typeof raw.status === "string") {
    if (!isKnownStatus(raw.status)) {
      throw new Error(
        `Unknown Claude CLI session status "${raw.status}" in ${SESSIONS_DIR}/${identity.pid}.json — update the status map`,
      );
    }
    status = raw.status;
  }
  return {
    sessionId: identity.sessionId,
    status,
    waitingFor: readString(raw.waitingFor),
    statusUpdatedAt:
      typeof raw.statusUpdatedAt === "number" ? raw.statusUpdatedAt : null,
  };
}

/**
 * Does this record claim this pane?
 *
 * Proximity is not ownership. Claude Code runs ONE background daemon per
 * machine, parented under whichever pane happened to start it, and lends its
 * pre-warmed spares to *any* conversation. So a completely unrelated agent's
 * process sits inside this pane's subtree, writes its sessions file hours after
 * this pane's own idle one, and — under the old freshest-wins rule — won. That
 * is how `conv-1786969506-7e03` came to render another worktree's messages.
 *
 * Two tiers, in order:
 *
 *   1. `self` — the record's `tmux` stamp names this pane. It said so; nothing
 *      beats that. Every CLI ≥ 2.1.233 stamps.
 *   2. `local` — the record cannot say so (no stamp at all), is not a background
 *      host, and runs in this pane's worktree.
 *
 * Tier 2 is not a convenience. A daemon-hosted process does not inherit
 * `$TMUX_PANE`, so a relocated session cannot stamp itself — and a stamp-only
 * rule would stop following relocations, which is exactly the failure that
 * froze a transcript for 747 minutes in July 2026 and again for 10h25m on
 * 2026-08-18. A stranger's messages showing up is visible and was caught in a
 * day; a silently frozen transcript is not. Tier 2 keeps the relocation case
 * resolvable while `kind !== "bg"` + `cwd` keep the lent spare out: the spare is
 * a background host running in someone else's worktree, so it fails both.
 *
 * Background sessions stay reachable through the explicit `parkedJobId` →
 * `jobId` pointer, which is authoritative. That is what lets tier 2 exclude
 * `kind: "bg"` outright without losing the parked case.
 */
function classify(identity: SessionIdentity, pane: PaneRef): ClaimTier {
  if (identity.stampedPaneId != null) {
    return identity.stampedPaneId === pane.paneId ? "self" : "rejected";
  }
  if (identity.kind === "bg") return "rejected";
  // An empty `worktreePath` (a pane tmux reports no start path for) can never
  // equal a real `cwd`, so tier 2 simply does not fire — correct: we have no
  // locality to test against.
  if (identity.cwd == null || identity.cwd !== pane.worktreePath) {
    return "rejected";
  }
  return "local";
}

/**
 * The stamped claimants that do not run below another stamped claimant.
 *
 * A stamp is read from `$TMUX_PANE`, which every child inherits. So when the
 * pane's agent runs a nested `claude` from its Bash tool (`claude --print …`),
 * that child stamps THIS pane too, writes its file after the pane's own idle
 * one, and would win on freshness — the pane's session id flips to the nested
 * run for as long as it lives (seen 2026-10-11: a `cd /tmp && claude --print`
 * adopted as pane %841's session, reported as `cwd-mismatch`). A stamped
 * process below a stamped claimant can only have inherited the stamp, so it is
 * the claimant's child, never the pane's session. Relocated sessions are
 * unaffected: a daemon-hosted process does not inherit `$TMUX_PANE`, so it
 * never stamps and never reaches tier 1.
 */
function outermost<T extends { identity: SessionIdentity }>(
  claimants: T[],
  tree: ProcessTree,
): T[] {
  if (claimants.length < 2) return claimants;
  const nested = new Set<number>();
  for (const { identity } of claimants) {
    for (const pid of subtreePids(tree, identity.pid).slice(1)) nested.add(pid);
  }
  return claimants.filter(({ identity }) => !nested.has(identity.pid));
}

/**
 * The session record in the pane's subtree that claims the pane, or null when
 * none does.
 *
 * The subtree walk itself is kept — it is the only channel that ever found a
 * relocated session, the `ps` snapshot is already taken once per reconcile batch,
 * and it is what makes the `foreign-session-outranked` evidence possible at
 * all. What changed is what we do with what it finds: the subtree is where we
 * *look*, the claim is what we *accept*.
 *
 * Within the winning tier, freshness orders the candidates: an idle interactive
 * session can go weeks without writing its file, so mtime against wall-clock
 * says nothing — it only ever compares candidates against each other. Ties
 * (identical mtime) resolve to the pid visited last in the BFS, so a
 * daemon-hosted child still beats its own launcher's tombstone.
 */
async function resolveClaimedRecord(
  pane: PaneRef,
  tree: ProcessTree,
  deps: SessionFileDeps,
): Promise<SessionIdentity | null> {
  const self: Array<{ identity: SessionIdentity; mtimeMs: number }> = [];
  const local: Array<{ identity: SessionIdentity; mtimeMs: number }> = [];
  const rejected: Array<{ identity: SessionIdentity; mtimeMs: number }> = [];

  for (const pid of subtreePids(tree, pane.panePid)) {
    const raw = await deps.readSessionFile(pid);
    if (raw == null) continue;
    const identity = parseIdentity(raw, pid, pane, deps);
    if (identity == null) continue;
    const mtimeMs = await deps.statSessionFile(pid);
    if (mtimeMs == null) continue; // exited and cleaned up between read and stat
    const entry = { identity, mtimeMs };
    const tier = classify(identity, pane);
    if (tier === "self") self.push(entry);
    else if (tier === "local") local.push(entry);
    else rejected.push(entry);
  }

  // Tier 2 is a fallback, never a peer: one stamped claimant settles the pane,
  // and any unstamped file beside it belongs to something else.
  const candidates = self.length > 0 ? outermost(self, tree) : local;

  if (candidates.length === 0) {
    // Silent when the subtree named no session at all — that is just Claude not
    // having written its file yet, the ordinary warm-up case. Loud when it did
    // name one and none of them claimed us: that is a shape the rule does not
    // cover, and it would otherwise be an invisible blank pane.
    if (rejected.length > 0) {
      deps.reportAnomaly({
        kind: "unclaimed-subtree-session",
        paneId: pane.paneId,
        message:
          `no session in the subtree of pid ${pane.panePid} claims this pane; ` +
          `${rejected.length} rejected`,
        detail: {
          panePid: pane.panePid,
          worktreePath: pane.worktreePath,
          rejected: rejected.map(({ identity }) => ({
            pid: identity.pid,
            sessionId: identity.sessionId,
            stampedPaneId: identity.stampedPaneId,
            cwd: identity.cwd,
            sessionKind: identity.kind,
          })),
        },
      });
    }
    return null;
  }

  let best = candidates[0]!;
  for (const entry of candidates) {
    if (entry.mtimeMs >= best.mtimeMs) best = entry;
  }

  // A rejected record fresher than the winner is exactly what the old rule
  // would have adopted. Counting them is how we learn whether cross-talk is a
  // one-off or a standing condition of this machine.
  for (const entry of rejected) {
    if (entry.mtimeMs <= best.mtimeMs) continue;
    deps.reportAnomaly({
      kind: "foreign-session-outranked",
      paneId: pane.paneId,
      message:
        `session ${entry.identity.sessionId} (pid ${entry.identity.pid}) is fresher than ` +
        `the claimed ${best.identity.sessionId} (pid ${best.identity.pid}) but claims no pane here`,
      detail: {
        panePid: pane.panePid,
        foreignPid: entry.identity.pid,
        foreignSessionId: entry.identity.sessionId,
        foreignCwd: entry.identity.cwd,
        foreignKind: entry.identity.kind,
        foreignStampedPaneId: entry.identity.stampedPaneId,
        claimedPid: best.identity.pid,
        claimedSessionId: best.identity.sessionId,
      },
    });
  }

  return best.identity;
}

/**
 * The sessions file of the background job `jobId`, or null when no live process
 * claims it. Scans every sessions file, since a parked job's host is re-parented
 * to launchd and so is unreachable from the pane's process tree.
 *
 * Only `jobId` is read before the liveness check: a full parse of every file on
 * the machine would make some other conversation's file decide this pane's fate.
 *
 * The liveness filter is load-bearing. A host that exited can leave its file
 * behind, and without the filter that leaked file is indistinguishable from a
 * second live claimant — which would throw, and wedge the pane at `NULL_STATE`
 * permanently. Two *live* claimants of one job id, on the other hand, is a real
 * contradiction with no safe answer, so that still throws.
 */
async function findJobHost(
  jobId: string,
  pane: PaneRef,
  livePids: ReadonlySet<number>,
  deps: SessionFileDeps,
): Promise<SessionIdentity | null> {
  const claimants: SessionIdentity[] = [];
  for (const pid of await deps.listSessionPids()) {
    const raw = await deps.readSessionFile(pid);
    if (raw == null) continue; // exited between the listing and the read
    if (readString((JSON.parse(raw) as { jobId?: unknown }).jobId) !== jobId)
      continue;
    if (!livePids.has(pid)) {
      deps.reportAnomaly({
        kind: "stale-job-host-file",
        paneId: pane.paneId,
        message: `sessions file ${pid}.json claims job ${jobId} but pid ${pid} is not running`,
        detail: { pid, jobId },
      });
      continue;
    }
    const identity = parseIdentity(raw, pid, pane, deps);
    if (identity == null) continue; // claims the job but names no session
    claimants.push(identity);
  }
  if (claimants.length > 1) {
    throw new Error(
      `Job ${jobId} is claimed by ${claimants.length} live processes ` +
        `(pids ${claimants.map((c) => c.pid).join(", ")}) — refusing to guess which one hosts the session`,
    );
  }
  return claimants[0] ?? null;
}

/**
 * Follow a parked session to wherever it is actually running.
 *
 * Claude Code can *park* a pane's session as a background job: it forks the
 * conversation to a new session id and hands it to a `--bg-pty-host` process
 * that launchd re-parents, leaving behind a stub in the pane that keeps
 * rendering the job through the daemon. The stub's own sessions file stops
 * being written at that instant and still names the pre-fork session id, so
 * mtime cannot find the live session — the subtree simply does not contain it,
 * and no amount of freshness comparison inside the subtree ever will.
 *
 * The stub does record `parkedJobId`, and the host's file records the matching
 * `jobId`. That pointer is the only link between them, so it is what we follow,
 * and it is authoritative — no mtime comparison, since a stale-by-construction
 * stub would win one, and no claim check, since the host is a background
 * process that by construction cannot stamp itself into this pane. A job that
 * has since exited leaves the stub as the best id we have, which is the
 * pre-park behaviour. `followed` bounds the walk, so a job that (or a cycle
 * that) parks again can never spin here.
 */
async function followParkedJob(
  stub: SessionIdentity,
  pane: PaneRef,
  livePids: ReadonlySet<number>,
  deps: SessionFileDeps,
): Promise<SessionIdentity> {
  let current = stub;
  const followed = new Set<string>();
  while (current.parkedJobId != null && !followed.has(current.parkedJobId)) {
    followed.add(current.parkedJobId);
    const host = await findJobHost(current.parkedJobId, pane, livePids, deps);
    if (host == null) return current; // the job is gone — keep what the pane names
    current = host;
  }
  return current;
}

/**
 * Resolve session state (sessionId + status + waitingFor) for a tmux pane: the
 * session in its process subtree that claims it, then — if that one has been
 * parked into a background job — the job it points at.
 */
export async function resolveSessionState(
  pane: PaneRef,
  tree: ProcessTree,
  deps: SessionFileDeps = defaultDeps,
): Promise<SessionState> {
  const claimed = await resolveClaimedRecord(pane, tree, deps);
  if (claimed == null) return NULL_STATE;
  const adopted = await followParkedJob(claimed, pane, tree.pids, deps);
  if (adopted.cwd != null && adopted.cwd !== pane.worktreePath) {
    // Only ever a report: the parked pointer we may have followed to get here
    // is authoritative, so a directory disagreement is evidence, not a veto.
    deps.reportAnomaly({
      kind: "cwd-mismatch",
      paneId: pane.paneId,
      message:
        `adopted session ${adopted.sessionId} (pid ${adopted.pid}) runs in ${adopted.cwd}, ` +
        `but the pane started in ${pane.worktreePath || "<unset>"}`,
      detail: {
        pid: adopted.pid,
        sessionId: adopted.sessionId,
        sessionCwd: adopted.cwd,
        worktreePath: pane.worktreePath,
      },
    });
  }
  return readSessionState(adopted);
}
