// The updater contract, the gate comparison and the upgrade task's text. The
// runner itself (gates that spawn `./equin check` / `test`) is CLI
// machinery, in this plugin's `cli/` barrel.
export type {
  AwaitingOn,
  Cooldown,
  Move,
  Outdated,
  OutdatedWaiting,
  PlanOptions,
  Updater,
  UpdaterPlan,
  UpdaterSmoke,
} from "./internal/updater";
export { isActionable } from "./internal/updater";
export { AWAIT_MAX_DAYS, boundedRows } from "./internal/awaiting";
export { cooldownEnd } from "./internal/cooldown";
// The hold model itself (HoldSchema, HOLD_MAX_DAYS, heldBy, …) is the
// `deps/hold` leaf's; here only what a held row reports and the review every
// updater's holds pass.
export { heldWaiting, reviewableHolds } from "./internal/hold";
export type { GateResult } from "./internal/compare";
export type { OutdatedUpdater } from "./internal/upgrade-prompt";
export type { DecisionSource, PendingDecision } from "./internal/decision";
export {
  DEPS_UPGRADE_PROMPT,
  hasUpgradeWork,
  outdatedSections,
  upgradeTaskTitle,
} from "./internal/upgrade-prompt";
