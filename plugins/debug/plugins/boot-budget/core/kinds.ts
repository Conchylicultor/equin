import { z } from "zod";

// The jsonb payload for a `boot-budget` report. One report per distinct boot span
// (fingerprint `boot-budget:<spanName>`); the row `count` discriminates a one-off
// slow boot (count 1) from a hook that is slow on EVERY boot (count grows across
// restarts). Carries which span, its phase + owning plugin, the wall-time it
// burned, the budget it blew, and the authoritative phase-boundary memory
// checkpoints so a human can tell a real heavy-work spike (RSS jumps) from a span
// that was merely awaiting IO (flat RSS).
export const BootBudgetPayloadSchema = z.object({
  spanName: z.string(),
  phase: z.string(),
  plugin: z.string().optional(),
  durationMs: z.number(),
  budgetMs: z.number(),
  // Where `budgetMs` came from, on reports filed while warm-ups (which could
  // declare one) were judged here. New reports omit it: every budget is the
  // per-phase config default.
  budgetSource: z.enum(["declared", "config"]).optional(),
  memoryCheckpoints: z
    .array(
      z.object({
        label: z.string(),
        atMs: z.number(),
        physFootprintMb: z.number(),
        heapUsedMb: z.number(),
      }),
    )
    .optional(),
});
export type BootBudgetPayload = z.infer<typeof BootBudgetPayloadSchema>;
