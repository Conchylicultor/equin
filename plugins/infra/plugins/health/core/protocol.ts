import { z } from "zod";

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  startedAt: z.number(),
  /**
   * Where this process's boot stands: `booting` (routes installed, the ready
   * barrier still running — the gateway routes nothing here yet), `ready` (the
   * barrier passed; post-ready phases still running), `settled` (every boot
   * phase ran, `onSettled` included).
   *
   * What a deploy's verdict reads: a backend that answered once and then died
   * in a post-ready phase never says `settled`, so `./equin build` counts a
   * namespace deployed only when the process that took over (same `startedAt`)
   * reports it.
   *
   * Absent on a backend from before this field — still answering while a
   * deploy replaces it — and never read as settled: optional so that answer
   * still parses (its `startedAt` is what a deploy compares against).
   */
  boot: z.enum(["booting", "ready", "settled"]).optional(),
  /**
   * WHICH build is answering, propagated from the bundle's `RELEASE.json`; both
   * null when this backend is not a release (dev, a worktree).
   *
   * Liveness alone is not enough for a deploy to prove it succeeded: a `current`
   * symlink that failed to flip leaves the PREVIOUS build serving happily, and a
   * gate that only asks "is something up?" would read that as success and move
   * on. Naming the run id is what makes "the build I just shipped is the build
   * now answering" checkable from off-box.
   */
  runId: z.string().nullable(),
  composition: z.string().nullable(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
