import { z } from "zod";

/**
 * `RELEASE.json` — the bundle's own self-description, written by
 * `./equin release` into the run dir and read back by everything that
 * wants to know what a bundle IS without re-deriving it from the path.
 *
 * `commitSha` / `commitDirty` are optional because bundles cut before
 * provenance existed carry neither. Absent ⇒ the source state is *unknown*,
 * which is a state of its own (see `Staleness`), never "current".
 *
 * Unknown keys are stripped rather than rejected: a newer CLI adding a field
 * must not make an older reader refuse an otherwise-shippable bundle. A
 * MALFORMED manifest is different — `.parse()` throws, and that throw is the
 * point: a corrupt RELEASE.json is not a refusal a user can act on, it is a
 * broken artifact.
 */
export const ReleaseManifestSchema = z.object({
  composition: z.string(),
  target: z.string(),
  platform: z.string(),
  builtAt: z.string(),
  port: z.number().int(),
  runId: z.string(),
  /** `git rev-parse HEAD` of the source tree, read BEFORE the artifact phase. */
  commitSha: z.string().nullable().optional(),
  /** `git status --porcelain` (incl. untracked) was non-empty at that instant. */
  commitDirty: z.boolean().nullable().optional(),
});

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
