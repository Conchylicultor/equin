import { z } from "zod";

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  startedAt: z.number(),
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
