// The pure half of `./equin await`: the exit-code vocabulary and the
// decision it makes from three readings (live markers, op-log records, process
// liveness). In `core/` because the codes are a contract a caller branches on —
// the guards' stop hook reads them too — and because keeping the decision pure
// is what lets it be tested without a running op.
export {
  AWAIT_EXIT,
  allSettled,
  decideStates,
  exitCodeFor,
  isTerminalOutcome,
} from "./internal/decide";
export type { AwaitedOp, OpState } from "./internal/decide";
