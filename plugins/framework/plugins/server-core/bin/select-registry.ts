import { existsSync } from "fs";
import { join } from "path";
import {
  MAIN_COMPOSITION_ID,
  NAMESPACE_LABEL_RE,
  NAMESPACE_RE,
} from "@plugins/infra/plugins/namespace/core";

/** The two registries a desktop backend boots as one graph (`bootPluginGraph`):
 *  every plugin's `server/` half and every plugin's `machine/` half. */
export type BackendRegistry = "server" | "machine";

/**
 * Which plugin registry this backend boots, keyed on the COMPOSITION its
 * worktree spec declares (read off disk by `./spec-composition`, which owns the
 * "where does that value come from" half of this):
 *
 *   1. No composition, or the main one ⇒ `<registry>.generated.ts`, the
 *      committed full registry. Unconditionally — a stray
 *      `server.composition.singularity.generated.ts` is inert.
 *   2. Any other composition ⇒ `<registry>.composition.<composition>.generated.ts`,
 *      that composition's filtered registry, and a THROW when it is absent.
 *
 * `registry` picks the half (`server` / `machine`); both are selected by the
 * same identity, so the two halves a backend boots always belong to one app.
 *
 * Selection is by identity, never by file presence. Presence used to be the rule
 * and it misfired in both directions: a `server.composition.singularity.…` file
 * silently reconfigured MAIN's backend on its next spawn (which is why building
 * the main composition was refused outright, and why the main app could not be
 * released), and a served composition whose checkout had been `git clean`ed lost
 * its filtered registry and silently booted the FULL app under the composition's
 * namespace and database. Both are the same bug: the answer to "which app is
 * this?" was inferred from whichever files happened to turn up, instead of being
 * stated. The spec states it; this function is only the lookup.
 *
 * So the two arms are deliberately asymmetric. Arm 1 ignores the disk because
 * the main composition's registry IS the committed one — the equality
 * `plugins-registry-in-sync` proves on every build, stated once in codegen's
 * `compositionRegistryFileName`. Arm 2 refuses to fall back, because booting a
 * superset of the requested app under that app's own namespace is worse than not
 * booting at all: it looks like it worked.
 *
 * Split out of `plugins-active.ts` so the chain is a pure `(coreDir, namespace,
 * composition) => path` function with a test. Importing `plugins-active.ts` to
 * exercise it would load every server plugin as a side effect.
 *
 * @param coreDir the `server-core/core` directory holding the registries
 * @param namespace this backend's runtime namespace (`runtimeNamespace()`, from
 *   the gateway's `--namespace`) — validated, not used to select; a bogus one
 *   means a broken spawn and boot should say so
 * @param composition the spec's `composition` field, from `readSpecComposition`
 *   (absent/empty ⇒ the main composition ⇒ the committed registry)
 * @param registry which half's registry to select
 */
export function selectRegistry(
  coreDir: string,
  namespace: string | undefined,
  composition: string | undefined,
  registry: BackendRegistry,
): string {
  const full = join(coreDir, `${registry}.generated.ts`);

  if (namespace !== undefined && namespace !== "") {
    // `namespace` is `<composition>.<checkout>` with both sentinels elided, so
    // it is one or two dot-joined labels, capped at 63 bytes because it is also
    // this backend's Postgres database name. A mismatch means a broken spawn,
    // not a missing registry: fail loudly rather than boot under a bogus
    // identity. Nothing below reads it — the guard is the whole point.
    //
    // The real `NAMESPACE_RE`, imported from the plugin that owns it. Boot can
    // reach it: `namespace/core` re-exports one module with ZERO imports, and
    // `paths/core` — which `bin/index.ts` and `plugins-active.ts` already import
    // — imports it already, so naming it here adds nothing to the boot closure.
    // (This file used to carry a hand-written copy, justified by a config_v2
    // closure that predates the namespace plugin being extracted.)
    //
    // The only copy of this grammar left in the tree is the gateway's, in Go,
    // which cannot import TypeScript. That one copy is what
    // `namespace:grammar-in-sync` pins; there is nothing left to pin here.
    if (!NAMESPACE_RE.test(namespace)) {
      throw new Error(
        `Invalid runtime namespace "${namespace}" — cannot select a plugin registry.`,
      );
    }
  }

  // Absent means "no composition was declared", which is the main app — the
  // shape every spec had before the field existed, and the shape `central`, an
  // unregistered namespace and a hand-run backend still have.
  if (composition === undefined || composition === "") return full;

  // A composition id is ONE namespace label: it becomes a filename segment, so
  // `../` or a dot in it would name a file outside this directory.
  if (!NAMESPACE_LABEL_RE.test(composition)) {
    throw new Error(
      `Invalid composition "${composition}" in this namespace's spec.json — cannot select a plugin registry.`,
    );
  }

  // The main composition's registry IS the committed one — the same fact
  // `compositionRegistryFileName` (codegen, not boot-reachable) encodes for
  // every other caller. Restated as a branch here, but off the SAME constant, so
  // "which id is main?" has one spelling in the tree.
  if (composition === MAIN_COMPOSITION_ID) return full;

  const filtered = join(
    coreDir,
    `${registry}.composition.${composition}.generated.ts`,
  );
  if (!existsSync(filtered)) {
    throw new Error(
      `Composition "${composition}" has no ${registry} registry at ${filtered}. ` +
        `A composition's registry is gitignored, so a \`git clean\` in this checkout ` +
        `removes it; rebuild the composition (Studio -> Compositions -> Serve) to emit it again. ` +
        `Refusing to boot the full app under this composition's namespace and database.`,
    );
  }
  return filtered;
}
