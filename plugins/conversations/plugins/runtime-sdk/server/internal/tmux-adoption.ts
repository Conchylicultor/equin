// Moving the conversations of the retired `tmux` runtime onto sdk — the pure
// decision (the boot step that applies it is machine/internal/adopt-tmux-rows.ts).
//
// A worktree's DB is a fork of main's, so it holds the same conversation ids —
// and tmux is host-wide, so `tmux kill-session -t <id>` from a worktree would
// kill main's live agent. A session is only ever killed by the backend that
// launched it: the one whose namespace the session's SINGULARITY_PARENT_HOST
// names (agent-launch's `agentSessionEnv` set it at launch).

export interface TmuxRow {
  id: string;
  status: string;
  hibernatedAt: Date | null;
}

/** What the tmux server says about a row's session. */
export type TmuxSession =
  | { kind: "none" }
  /** A session, launched by the backend `parentHost` names (null: unknown). */
  | { kind: "live"; parentHost: string | null };

export interface TmuxAdoptionStep {
  id: string;
  /** Kill the session first: it is this backend's own agent. */
  kill: boolean;
  /** Mark the row hibernated (the process is gone; a Send resumes it). */
  hibernate: boolean;
  /** Settle a row left `working` / `starting` to `waiting`: nothing computes. */
  settleToWaiting: boolean;
}

const LIVE_STATUSES = new Set(["starting", "working", "waiting"]);

export function planTmuxAdoption(
  row: TmuxRow,
  session: TmuxSession,
  ownNamespace: string,
): TmuxAdoptionStep {
  const live = LIVE_STATUSES.has(row.status);
  return {
    id: row.id,
    kill: session.kind === "live" && session.parentHost === ownNamespace,
    // A `gone` row stays gone (Resume is its way back) and a `done` row stays
    // done; only a row that claims a live process becomes hibernated.
    hibernate: live && row.hibernatedAt === null,
    settleToWaiting: row.status === "working" || row.status === "starting",
  };
}
