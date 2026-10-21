import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * Pre-write snapshots of every file an agent-origin request overwrote, pending
 * revert: one `<namespace>/<ledger-id>.json` per registered ledger per runtime
 * namespace. See `research/2026-09-16-global-shared-prototype-option-picks.md`
 * (§ 4) and, for where it came from,
 * `research/2026-08-30-global-agent-config-write-revert-ledger.md`.
 *
 * **Deliberately NOT inside any domain's own data.** A new worktree's workspace
 * recursively copies main's config tree into its own (`forkConfigDir`,
 * conversations/workspace/worktree), so a ledger
 * living there would be inherited by a fresh worktree — whose first
 * start-repair would then "revert" files that are legitimately in place,
 * silently reverting the user's config to an unrelated worktree's pre-agent
 * state. The same holds for any future domain that forks its data per
 * worktree; one dir outside all of them is correct for every ledger.
 *
 * Declared by config_v2 until the ledger became a shared primitive; the
 * directory name is unchanged, so the move left no orphan behind. A
 * `<namespace>/ledger.json` inside it is config_v2's pre-primitive ledger and is
 * read by nothing — see this plugin's `CLAUDE.md`.
 */
export const agentWriteLedgerDir = defineDataDir({
  kind: "state",
  name: "agent-write-ledger",
  owner: "infra/request-origin/agent-write-ledger",
  description:
    "Pre-write snapshots of the files an automated session overwrote (config documents, prototype option picks, …), held until the e2e harness reverts them",
  reclaim: {
    kind: "never",
    reason:
      "the only copy of the bytes an agent run overwrote; deleting it makes the pending revert impossible and freezes the agent's edit into the user's data",
  },
});

export default [agentWriteLedgerDir];
