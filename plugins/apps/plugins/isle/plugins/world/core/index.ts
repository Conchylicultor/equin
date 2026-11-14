export {
  arcsOf,
  cutAt,
  pointIndex,
  segDist,
  spline,
} from "./internal/geometry";
export type { PointIndex, Pt } from "./internal/geometry";
export {
  adoptHomeCarve,
  DOCK_ROOT,
  HOME_CX,
  HOME_CY,
  HOME_RX,
  HOME_RY,
  homeAt,
  homeCarveBuilt,
  homeCarveGrid,
  RIVER,
  LAKE,
  riverWidth,
} from "./internal/home";
export { kindOf, planIsland } from "./internal/island-shape";
export type {
  CoastPoint,
  IslandKind,
  IslandOptions,
  IslandPlan,
  IslandShape,
  IslandShapeData,
} from "./internal/island-shape";
export {
  districtLabels,
  districtName,
  islandLabels,
  labelSpotScore,
  pickLabelSpot,
} from "./internal/labels";
export type { DistrictLabel, IslandLabel } from "./internal/labels";
export { layoutWorld, roadHash } from "./internal/layout";
export type {
  Ferry,
  Layout,
  Pier,
  PlacedBuilding,
  Road,
  RoadKind,
  RoadSample,
  Square,
} from "./internal/layout";
export { fbm, hash, smoothstep, vnoise } from "./internal/noise";
export { applyMove, moveTargets } from "./internal/move";
export type { MoveTarget } from "./internal/move";
export {
  districtCategory,
  EMPTY_PLACEMENT,
  islandsInPlay,
  placeResidents,
  plotBoxes,
  plotById,
  signHalfWidth,
} from "./internal/placement";
export type { Placement, Plot, Resident } from "./internal/placement";
export { residentOf } from "./internal/resident";
export { plotBox, plotsClash } from "./internal/sites";
export type { PlotBoxes } from "./internal/sites";
export { findPath, walkable, walkGrid, WALK_CELL } from "./internal/walk";
export type { Solid, WalkGrid } from "./internal/walk";
export { Island, ISLAND_COUNT, Slot, WorldModel } from "./internal/world-model";
export type { Hill } from "./internal/world-model";
