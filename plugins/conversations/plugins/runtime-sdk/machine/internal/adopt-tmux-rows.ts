import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import {
  setConversationHibernated,
  updateConversation,
} from "@plugins/tasks/plugins/tasks-core/server";
import { requestStatusReconcile } from "@plugins/conversations/server";
import {
  listTmuxConversations,
  moveToSdkRuntime,
} from "../../server/internal/rows";
import {
  planTmuxAdoption,
  type TmuxSession,
} from "../../server/internal/tmux-adoption";
import { tmux } from "./tmux";

// The tmux runtime is retired: at boot, every conversation still on it moves
// to sdk (the plan: server/internal/tmux-adoption.ts). Idempotent and ordered
// so a crash anywhere retries cleanly on the next boot — kill first, settle the
// row, and switch its runtime LAST, which is what takes it out of the next
// boot's list. Delete once no database holds a `tmux` row.

/** The tmux server's sessions; none when no server runs. */
async function liveSessions(): Promise<Set<string>> {
  const r = await tmux(["list-sessions", "-F", "#{session_name}"]);
  if (r.exitCode === 0) return new Set(r.stdout.split("\n").filter(Boolean));
  if (/no server running|error connecting/.test(r.stderr)) return new Set();
  throw new Error(
    `tmux list-sessions failed (${r.exitCode}): ${r.stderr.trim()}`,
  );
}

/** Which backend launched `id`'s live session (null: it never said). */
async function launcherOf(id: string): Promise<string | null> {
  const r = await tmux([
    "show-environment",
    "-t",
    id,
    "SINGULARITY_PARENT_HOST",
  ]);
  if (r.exitCode === 0) return r.stdout.trim().split("=", 2)[1] ?? null;
  if (/unknown variable/.test(r.stderr)) return null;
  throw new Error(
    `tmux show-environment -t ${id} failed (${r.exitCode}): ${r.stderr.trim()}`,
  );
}

async function sessionOf(
  id: string,
  live: ReadonlySet<string>,
): Promise<TmuxSession> {
  if (!live.has(id)) return { kind: "none" };
  return { kind: "live", parentHost: await launcherOf(id) };
}

async function killSession(id: string): Promise<void> {
  const r = await tmux(["kill-session", "-t", id]);
  if (
    r.exitCode !== 0 &&
    !/no such session|can't find session/.test(r.stderr)
  ) {
    throw new Error(
      `tmux kill-session -t ${id} failed (${r.exitCode}): ${r.stderr.trim()}`,
    );
  }
}

export async function adoptTmuxRows(): Promise<void> {
  const rows = await listTmuxConversations();
  if (rows.length === 0) return;
  const namespace = runtimeNamespace();
  const live = await liveSessions();
  const moved: string[] = [];
  for (const row of rows) {
    const step = planTmuxAdoption(
      row,
      await sessionOf(row.id, live),
      namespace,
    );
    if (step.kill) await killSession(row.id);
    if (step.hibernate) await setConversationHibernated(row.id, new Date());
    if (step.settleToWaiting) {
      await updateConversation(row.id, { status: "waiting", waitingFor: null });
    }
    await moveToSdkRuntime(row.id);
    moved.push(row.id);
  }
  requestStatusReconcile(moved);
}
