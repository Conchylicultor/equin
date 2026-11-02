import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { dirname } from "path";
import {
  formatIfFormattable,
  type SourceBytes,
} from "@plugins/framework/plugins/tooling/plugins/format/core";

/**
 * The ONE write seam for every generated artifact.
 *
 * The idiom `if (next !== existing) writeFileSync(file, next)` used to be spelled
 * out at thirteen emit sites, and each `*-in-sync` check re-spelled the matching
 * comparison. That is two owners of the on-disk byte format, which is exactly how
 * an emitter and its checker drift apart. Both sides now call
 * {@link formatGenerated}, so they cannot.
 */

/**
 * The exact bytes that would be written for `file`.
 *
 * Path-driven via the format allowlist, so `.md` (docgen) and `.jsonc` (config
 * origins, authored overrides) route through this SAME funnel and come back
 * unchanged. No special-casing, no per-emitter opt-in.
 *
 * This is the CODEGEN-SIDE NAME for a policy owned elsewhere, kept as a named
 * seam because it states intent at every emit and check site. Whether
 * `*.generated.ts` is formatted is decided by `FORMAT_GENERATED_ARTIFACTS` in
 * `format/core` — which the build's changed-set pass reads too. Do not
 * reintroduce a local copy of that switch: when the two writers disagreed, the
 * symptom was a deterministic ping-pong (codegen writes the file, the format
 * pass — which runs after all codegen — rewrites it) and every `*-in-sync`
 * check over a generated file went red.
 *
 * Callers are BOTH the emitters (via {@link writeGenerated}) and the `*-in-sync`
 * checks, which compare disk against
 * `formatGenerated({ file, content: renderX(...) })`. Applying it on both sides
 * rather than inside each `renderX` keeps one owner of the byte format and
 * leaves the sync renderers sync.
 *
 * This is the ONE caller of `formatIfFormattable` — the permissive arm of the
 * format seam — because this is the one file set that legitimately spans
 * non-formattable paths. `formatSource` itself now throws on those, so a
 * swapped or garbage argument can no longer masquerade as a pass-through.
 */
export async function formatGenerated(bytes: SourceBytes): Promise<string> {
  return await formatIfFormattable(bytes);
}

/**
 * The ONE write idiom for every generated artifact: render → format → write iff
 * the bytes differ.
 *
 * Write-on-difference is load-bearing, not an optimization: web artifacts are
 * fingerprinted on `(mtimeMs, size)`, so an unconditional write would invalidate
 * an artifact whose bytes never changed and rebuild the fleet for nothing.
 *
 * The parent directory is created on the write path, so an emitter producing a
 * file at a not-yet-existing path (config origins, seeded overrides) does not
 * have to remember to `mkdirSync` first.
 *
 * Arguments are NAMED because this one WRITES: positionally, a `(content,
 * file)` slip created a file named after its own content and filled it with a
 * path. See {@link SourceBytes}.
 */
export async function writeGenerated(
  bytes: SourceBytes & { file: AppPath },
): Promise<void> {
  const { file } = bytes;
  const next = await formatGenerated(bytes);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (next === existing) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
}
