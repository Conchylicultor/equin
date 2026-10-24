import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pagesSearchBackfillWarmup } from "./internal/backfill-warmup";

export default {
  description:
    "Pages full-text search, desktop-only half: the boot warm-up that enqueues the backfill scan, so pages that predate the index (or drifted) become searchable. Warm-ups never run on a browser host.",
  // The warm-up enqueues the seed scan off the serving-critical boot path (see
  // backfill-warmup.ts); the backfill job itself is the server half's.
  register: [pagesSearchBackfillWarmup],
} satisfies MachinePluginDefinition;
