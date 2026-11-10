import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The last commit each budget scenario was measured within budget at, one
 * `<scenario>.json` per scenario — what an over-budget report names as the
 * start of its commit range. Written only by a filing run (main's), so an
 * on-demand run in a worktree never moves it.
 *
 * @see plugins/reports/plugins/interaction-budget/e2e/internal/settle.ts
 */
export const interactionBudgetStateDir = defineDataDir({
  kind: "state",
  name: "interaction-budget",
  owner: "reports/interaction-budget",
  description:
    "The last commit each interaction-budget scenario was measured within budget at, one small JSON file per scenario",
  reclaim: {
    kind: "never",
    reason:
      "the only record of where a regression's commit range starts; one tiny file per scenario",
  },
});

export default [interactionBudgetStateDir];
