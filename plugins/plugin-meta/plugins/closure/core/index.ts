export { classifyEdges } from "./classify-edges";
export { collectCompanionSlots, slotGroupOwners } from "./companion-slots";
export type { CompanionSlot, CompanionEntry } from "./companion-slots";
export {
  resolveComposition,
  hardClosure,
  removalClosure,
  expandEntrySeeds,
} from "./resolve-composition";
export { parseEntryPattern, matchEntryPattern } from "./entry-pattern";
export type { EntryPattern, ParsedPattern } from "./entry-pattern";
export { flattenManifest } from "./flatten-manifest";
export { explainInclusion } from "./explain";
export { impactOfPruning, impactOfSelecting } from "./impact";
export { serializeEdgeGraph, deserializeEdgeGraph } from "./serialize";
export type { SerializedEdgeGraph } from "./serialize";
export type {
  EdgeKind,
  HardEdgeVia,
  Edge,
  EdgeGraph,
  CompositionManifest,
  MembershipState,
  Composition,
  InclusionStep,
  InclusionPath,
  UnsatisfiedExclusion,
  UsageRule,
} from "./types";
