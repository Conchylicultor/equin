import { attemptConvAgg, attemptPushAgg } from "./rollup-spec";
import { TASK_MATERIALIZED_ROLLUPS } from "./task-rows";

// Every rollup this plugin contributes (`DerivedTable`, server/index.ts) — the
// one list the boot contributions, the headless derived-schema install and the
// relation-bases suite all read, so a new rollup cannot be missed by any: the
// two attempt rollups and the `tasks` collection's materialized joins (which
// read them).
export const TASK_ROLLUPS = [
  attemptConvAgg,
  attemptPushAgg,
  ...TASK_MATERIALIZED_ROLLUPS,
] as const;
