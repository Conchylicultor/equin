export {
  PLUGIN_MOVES_FILE,
  appendPluginMove,
  movedPluginId,
  pluginMoveKey,
  readPluginMoves,
} from "./internal/ledger";
export type { PluginMove } from "./internal/ledger";
export {
  APPLIED_MOVES_FILE,
  applyPluginMoves,
  namespacesHolding,
} from "./internal/apply-moves";
export type { AppliedMove } from "./internal/apply-moves";
export {
  restampMovedOverrides,
  snapshotConfigOrigins,
} from "./internal/restamp-moved";
