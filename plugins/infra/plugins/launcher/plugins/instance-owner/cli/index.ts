// Shared CLI machinery, not a command (no default export): which checkout this
// account's equin runs from, and the refusal of every other one.
export {
  assertThisInstance,
  instanceClaims,
  judgeInstance,
  otherInstanceNotice,
} from "./internal/owner";
export type {
  InstanceAction,
  InstanceClaim,
  InstanceVerdict,
} from "./internal/owner";
