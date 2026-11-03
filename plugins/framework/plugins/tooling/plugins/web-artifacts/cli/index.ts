// Shared CLI machinery of the web-artifact builder — NOT a command. There is no
// default export, so the `cli` collected dir never registers this barrel; the
// build command imports it like any other `cli/` barrel.
//
// Why a `cli/` barrel rather than `core/`: `builderSourceDigest` hashes every
// file under `core/` into every artifact address, so code that only touches a
// served dist AFTER the fleet is built must stay out of it, or each edit to it
// would rebuild the whole fleet on every host.
export { carryForwardServedEntries } from "./internal/carry-forward";
export type { CarryForwardResult } from "./internal/carry-forward";
export {
  createPooledArtifactBuilder,
  idealArtifactBuildThreads,
} from "./internal/pooled-builder";
