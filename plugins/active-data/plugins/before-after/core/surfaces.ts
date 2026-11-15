import type { IdChipSurface } from "@plugins/active-data/plugins/id-chip/core";

/** Where a before / after chip belongs — read by BOTH halves, so they cannot disagree. */
export const BEFORE_AFTER_CHIP_SURFACES: readonly IdChipSurface[] = [
  "transcript",
  "document",
];
