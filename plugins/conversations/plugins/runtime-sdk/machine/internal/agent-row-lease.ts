import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import {
  readAgentRow,
  readAgentRows,
  resetAgentRow,
  updateAgentRow,
  type AgentRow,
} from "../../server/internal/rows";

// The one writer of each agent's `conversations_ext_sdk_agent` row. Every
// write — the consumer's projection after a batch, a launch preparing the row,
// a relaunch naming its session — runs under the agent's lease, one at a time,
// and the lease holds the row as last written. So a catch-up starts from the
// row in memory instead of re-reading it per batch, and no launch write can
// land between a catch-up's read and its write (before, a catch-up that read
// the row just ahead of a relaunch wrote the predecessor's `sessionId` back
// over the relaunch's).
//
// Sound only because this process is the row's sole writer: the runtime is
// served by one backend per DB (a worktree's DB is its own fork), and nothing
// else updates the table.
//
// Only a writer's lease starts holding a row, and the consumer releases it after
// a catch-up of an agent it no longer follows — so what is held is bounded by
// the agents running (and launching), not by every conversation caught up.

const leases = createKeyedMutex();
const held = new Map<string, AgentRow>();

/** The agent's row under its lease: read it, write it, or stop holding it. */
export interface AgentRowLease {
  /** The row as last written (or read); null before its first `create`. */
  readonly row: AgentRow | null;
  /**
   * Write `patch` and hold the row as written. Null when the row is gone (its
   * conversation was deleted) — nothing is held then.
   */
  update(patch: Partial<AgentRow>): Promise<AgentRow | null>;
  /** Write a fresh row (the empty projection, cursor 0) and hold it. */
  reset(worktreePath: string, sessionId: string): Promise<AgentRow>;
  /** Stop holding the row: the next lease reads it from the DB again. */
  release(): void;
}

/**
 * Run `fn` as the agent's row's only writer: once every earlier lease of the
 * same agent settled, with the row loaded (from memory, else one read).
 */
export function leaseAgentRow<T>(
  id: string,
  fn: (lease: AgentRowLease) => Promise<T>,
): Promise<T> {
  return leases.run(id, async () => {
    if (!held.has(id)) {
      const row = await readAgentRow(id);
      if (row) held.set(id, row);
    }
    return fn({
      get row() {
        return held.get(id) ?? null;
      },
      async update(patch) {
        const row = await updateAgentRow(id, patch);
        if (row) held.set(id, row);
        else held.delete(id);
        return row;
      },
      async reset(worktreePath, sessionId) {
        const row = await resetAgentRow(id, worktreePath, sessionId);
        held.set(id, row);
        return row;
      },
      release() {
        held.delete(id);
      },
    });
  });
}

/**
 * The agent's current row: the held one (the last committed write, so reading
 * it needs no lease), else read after the writes in flight — and not held: only
 * a writer's lease starts holding a row.
 */
export async function currentAgentRow(id: string): Promise<AgentRow | null> {
  return (
    held.get(id) ??
    leases.run(id, async () => held.get(id) ?? (await readAgentRow(id)))
  );
}

/**
 * Many agents' current rows: the held ones from memory, the rest in one read
 * (not held — a plain read, as current as the DB).
 */
export async function currentAgentRows(
  ids: readonly string[],
): Promise<Map<string, AgentRow>> {
  const out = new Map<string, AgentRow>();
  const missing: string[] = [];
  for (const id of ids) {
    const row = held.get(id);
    if (row) out.set(id, row);
    else missing.push(id);
  }
  for (const [id, row] of await readAgentRows(missing)) out.set(id, row);
  return out;
}
