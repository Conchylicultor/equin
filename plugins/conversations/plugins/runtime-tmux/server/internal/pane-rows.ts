import { TMUX_HOSTED_BY_OPTION } from "@plugins/conversations/plugins/agent-launch/core";
import { conversationIdKind } from "@plugins/tasks/plugins/task-ids/core";
import type { PaneRef } from "./claude-session";

/**
 * The tmux session names this runtime launches. The ONE statement of it: the
 * pane listing (`parsePaneRows`) and every signal route (signals.ts) test this
 * constant. A session under another name is listed only when it was started
 * from an agent worktree (see `parsePaneRows`).
 *
 * It used to be stated twice, the second time as a tmux `-f` filter written
 * `#{r:…}` — not a tmux modifier, and it kept every pane, so the sweep adopted
 * every session on the host whose start path was a worktree
 * (research/2026-10-07-conversations-status-shadow-audit-retirement.md).
 *
 * Derived from the conversation id KIND's namespace (`conv-`, plus its legacy
 * `claude-` alias), not re-typed: a prefix test, deliberately looser than the
 * kind's full shape, so a session is never dropped for a body the shape test
 * would quibble with.
 */
export const AGENT_SESSION_RE = new RegExp(
  `^(?:${conversationIdKind.prefixes.join("|")})-`,
);

// Field separator: tab (not present in pane paths or titles) keeps splits
// unambiguous even though pane titles can contain arbitrary characters.
const SEP = "\t";

/**
 * The `list-panes -F` format `parsePaneRows` reads. The title is last: it is
 * the one field that may itself contain the separator. The host option reads
 * empty for a session nothing set it on.
 */
export const PANE_ROW_FORMAT = [
  "#{session_name}",
  "#{pane_pid}",
  "#{pane_id}",
  "#{pane_dead}",
  "#{pane_start_path}",
  `#{${TMUX_HOSTED_BY_OPTION}}`,
  "#{pane_title}",
].join(SEP);

/**
 * One live pane as `listPanes` reports it. It extends `PaneRef`, so a pane can
 * be handed straight to `resolveSessionState` — the resolver's inputs are a
 * strict subset of what listing a pane already tells us, and there is nothing
 * to assemble (or mis-assemble) at the call site.
 *
 * `#{pane_id}` is the pane's identity for its whole life. `#{window_id}` is
 * deliberately not carried: it moves under `break-pane` / `move-window`, and
 * matching on it would buy nothing that `%pane_id` does not already settle.
 */
export interface TmuxPane extends PaneRef {
  rawTitle: string;
  dead: boolean;
}

/**
 * `list-panes -a -F PANE_ROW_FORMAT` output → the panes this runtime tracks,
 * keyed by session name (= conversation id):
 *
 * - every session named like one we launch (`AGENT_SESSION_RE`), and
 * - any other session started FROM an agent worktree (`isAgentWorktree` of its
 *   start path) — something an agent ran outside the conversation launcher, a
 *   `tmux new-session` from its checkout. Main adopts those as *lost*
 *   conversations (the queue's Lost section), so nothing an agent leaves
 *   running goes unseen. No signal names them; the minute sweep follows them.
 *
 * Everything else (the user's own sessions) is never listed, captured or
 * probed — and neither is a session another runtime hosts its agent in (it
 * carries `TMUX_HOSTED_BY_OPTION`): tmux only supervises and shows that
 * process, its conversation belongs to that runtime, and adopting it here
 * would claim it as a tmux conversation twice over. The first pane of a
 * session wins; malformed lines are skipped.
 */
export function parsePaneRows(
  stdout: string,
  isAgentWorktree: (path: string) => boolean,
): Map<string, TmuxPane> {
  const map = new Map<string, TmuxPane>();
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const [name, pidStr, paneId, deadStr, startPath, hostedBy, ...rest] =
      line.split(SEP);
    if (!name || !pidStr || !paneId) continue;
    if (hostedBy) continue;
    const worktreePath = startPath ?? "";
    if (!AGENT_SESSION_RE.test(name) && !isAgentWorktree(worktreePath))
      continue;
    if (map.has(name)) continue;
    const pid = Number(pidStr);
    if (!Number.isFinite(pid)) continue;
    map.set(name, {
      panePid: pid,
      paneId,
      dead: deadStr === "1",
      worktreePath,
      rawTitle: rest.join(SEP),
    });
  }
  return map;
}
