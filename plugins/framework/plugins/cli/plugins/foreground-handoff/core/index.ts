// The hand-off contract both sides read: which ops may run in an agent's
// foreground Bash call (the guard lets them through and exports the deadline),
// and how that deadline is derived from the call's time limit (the CLI hands
// the op off at it).
export {
  FOREGROUND_HANDOFF_OPS,
  foregroundDeadline,
  isHandoffOp,
} from "./internal/handoff-ops";
export type { HandoffOp } from "./internal/handoff-ops";
