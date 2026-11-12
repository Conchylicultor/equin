import { createContext, useContext } from "react";
import type { Journey } from "./journey";

/**
 * What every row of one loaded window shares: the axis' far end (so bars
 * compare across rows), each path's estimated sections (the "read %" of a
 * page that did not record its own list — `pageRead`), and each
 * visit's journey (derived once per window, not once per render of a row).
 * Provided around the DataView's source bundle, read by the rows, the axis row in the toolbar
 * band and the expanded timeline alike.
 */
export interface LaneWindow {
  axisMaxS: number;
  sections: ReadonlyMap<string, readonly string[]>;
  journeys: ReadonlyMap<string, Journey>;
  /** The toolbar's summary of the window — `null` while its rows are not known yet. */
  summary: LaneSummary | null;
}

/**
 * What the toolbar says about the visits: how many the view matches (the
 * collection's count — `null` while not known, then the loaded rows are a
 * lower bound), and figures over the LOADED visits.
 */
export interface LaneSummary {
  total: number | null;
  loaded: number;
  medianS: number | null;
  medianLoadMs: number | null;
  withActions: number;
}

export const LaneWindowContext = createContext<LaneWindow | null>(null);

export function useLaneWindow(): LaneWindow {
  const w = useContext(LaneWindowContext);
  if (w === null)
    throw new Error("[sessions] a lane rendered outside its window");
  return w;
}

/**
 * The lane's three columns — visitor facts · journey · duration — as ONE
 * track spec, shared by every row and the sticky axis row above them, so the
 * ticks stand exactly over the bars they measure.
 */
export const LANE_TRACKS =
  "grid grid-cols-[minmax(200px,250px)_minmax(0,1fr)_96px] gap-lg";
