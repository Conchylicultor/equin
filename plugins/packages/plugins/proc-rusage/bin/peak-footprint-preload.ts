// Preloaded into a bun script child whose spawner asked for its peak physical
// footprint (`peakFootprintReportEnv`, `../core/internal/peak-footprint.ts`),
// through `BUN_OPTIONS`. Never imported — run by path. Everything it does is
// `armPeakFootprintReportSync`'s: take the request out of the environment, and
// write the lifetime peak to the parent's file as the process exits.
import { armPeakFootprintReportSync } from "../core";

armPeakFootprintReportSync();
