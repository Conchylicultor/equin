// The server half of the keyed-delta wire contract, so the client merge's
// round-trip suite (live-state) can drive the real producer against its consumer.
export {
  buildSnapshot,
  diffKeyedFull,
  diffKeyedScoped,
  hashSnapEncoder,
} from "../keyed-diff";
export type { KeyedSnapshot } from "../keyed-diff";
// The faithful client simulator (sub-ack / update / delta / invalidate, the
// version guard and the keyed merge), for a suite driving a real runtime over
// a socket — network/live's differential oracle compares each view against a
// fresh FULL load.
export { makeClientView } from "../test-support";
export type {
  ClientView,
  DeriveFrame,
  DeriveSourceFrame,
  RecordedFrame,
} from "../test-support";
// The shared routed fixture (P8 step 23b): a keyed resource declared the way a
// compiled collection is — a minted identity route and a membership — plus the
// change feed's delivery, a non-keyed value's whole-table reach plan, and the
// runtime harness itself.
export {
  defineRoutedTable,
  feedChange,
  identityPlan,
  wholeReach,
} from "./routed-fixture";
export type { FedChange, RoutedTable, RoutedTableSpec } from "./routed-fixture";
export { createHarness } from "../test-support";
export type { Harness } from "../test-support";
