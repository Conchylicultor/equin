// The updater contract, the gate comparison and the upgrade task's text. The
// runner itself (gates that spawn `./singularity check` / `test`) is CLI
// machinery, in this plugin's `cli/` barrel.
export type {
  Move,
  Outdated,
  OutdatedWaiting,
  Updater,
  UpdaterSmoke,
} from "./internal/updater";
export { isActionable } from "./internal/updater";
export type { Hold } from "./internal/hold";
export {
  HOLD_MAX_DAYS,
  HoldSchema,
  heldBy,
  heldWaiting,
  holdProblems,
  reviewableHolds,
  utcDay,
} from "./internal/hold";
export type { GateResult } from "./internal/compare";
export type { OutdatedUpdater } from "./internal/upgrade-prompt";
export {
  DEPS_UPGRADE_PROMPT,
  hasUpgradeWork,
  outdatedSections,
  upgradeTaskTitle,
} from "./internal/upgrade-prompt";
