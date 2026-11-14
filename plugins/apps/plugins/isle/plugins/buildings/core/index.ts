export { GROUND_BAND, SETTINGS } from "./spec";
export type {
  BuildingSpec,
  Box,
  Chimney,
  Ctx2D,
  Footprint,
  Light,
  PaintState,
  Setting,
} from "./spec";
export { shade } from "./shade";

// The painting kit: the drawing helpers generated buildings are made of, for
// bespoke buildings to reuse.
export type { Rnd, Rgb } from "./internal/colour";
export { accent, css, dark, jit, light, mix, rgb } from "./internal/colour";
export type {
  Pt,
  PlanksOptions,
  ShinglesOptions,
  StonesOptions,
  WashOptions,
} from "./internal/draw";
export {
  bbox,
  castShadow,
  grain,
  hline,
  ink,
  ivy,
  moss,
  planks,
  poly,
  rectPts,
  shingles,
  shrub,
  sketch,
  stones,
  thatch,
  tufts,
  wash,
} from "./internal/draw";
export type { DoorArchOptions, WindowOptions } from "./internal/parts";
export {
  barrel,
  bench,
  books,
  chimneySmoke,
  crate,
  doorArch,
  lantern,
  sack,
  spill,
  steps,
  windowRect,
} from "./internal/parts";
export {
  cart,
  draftingTable,
  easel,
  flowerBox,
  gear,
  ladder,
  lute,
  mailbox,
  swingFrame,
  toolRack,
  waterButt,
} from "./internal/props";

// The polygon kit: the second hand (faces as polygons, palette colour), namespaced.
export { polyKit } from "./internal/poly-kit";

// The generator.
export { categoryOfSeed, kitBuilding } from "./internal/kit-building";
