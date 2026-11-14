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
/**
 * The version of the contract between ship's activate script and the bundle it
 * activates — what the bundle's self-extractor and `launch` binary answer to:
 *
 *   - the extractor, run with `RELEASE_EXTRACT_ONLY=1`, extracts, prints the
 *     extracted dir and exits — it starts nothing;
 *   - `launch swap` swaps the backend through the running gateway, or exits 3
 *     when the release changes the host; any other verb is refused;
 *   - a boot of the host records its host generation (`host-generation.json`),
 *     which the next ship's swap compares against.
 *
 * Bump it whenever the activate script (`framework/cli/deploy`,
 * `activate-script.ts`) asks a bundle for something an older bundle does not
 * do. A bundle declaring another version is refused before upload
 * (`resolveBundle`, `activation-protocol`): ship cannot speak to it. A bundle
 * that predates the field speaks none — its extractor ignores
 * `RELEASE_EXTRACT_ONLY` and boots a whole host, which on 2026-11-14 started a
 * second gateway beside the website's serving one.
 */
export const RELEASE_ACTIVATION_PROTOCOL = 1;

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
  /**
   * The activate protocol this bundle speaks ({@link RELEASE_ACTIVATION_PROTOCOL}
   * when it was built). Absent on a bundle built before the field: it speaks
   * none, and ship refuses it.
   */
  activationProtocol: z.number().int().optional(),
});

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
