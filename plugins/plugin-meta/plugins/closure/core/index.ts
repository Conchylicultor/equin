export { classifyEdges } from "./classify-edges";
export { collectCompanionSlots, slotGroupOwners } from "./companion-slots";
export type { CompanionSlot, CompanionEntry } from "./companion-slots";
export {
  resolveComposition,
  hardClosure,
  removalClosure,
  expandEntrySeeds,
} from "./resolve-composition";
export { matchEntryPattern } from "./entry-pattern";
export { flattenManifest } from "./flatten-manifest";
export { graphForHosts } from "./host-view";
export { explainInclusion } from "./explain";
export { stepLabel } from "./inclusion-path";
export { impactOfPruning, impactOfSelecting } from "./impact";
export { serializeEdgeGraph, deserializeEdgeGraph } from "./serialize";
export type { SerializedEdgeGraph } from "./serialize";
export type {
  EdgeKind,
  HardEdgeVia,
  Edge,
  HardEdge,
  EdgeGraph,
  CompositionManifest,
  MembershipState,
  Composition,
  InclusionStep,
  InclusionPath,
  UnsatisfiedExclusion,
  UsageRule,
} from "./types";
