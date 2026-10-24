import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";

/**
 * Is this run a plain build of the checkout's own app — i.e. `./equin
 * build` with no `--composition`?
 *
 * The one place the question is answered, because six surfaces used to answer it
 * by comparing `target === "main"` against a column that defaulted to `"main"`
 * while the row's `namespace` defaulted to `"singularity"` — the same row saying
 * both. A build's targets are composition ids now, and the main app is an
 * ordinary composition whose id IS `MAIN_COMPOSITION_ID`, so the literal has no
 * spelling left anywhere.
 *
 * A multi-target invocation that happens to include the main composition is NOT
 * a plain build: it also published somebody else's namespace, which is exactly
 * what the callers (the toolbar label, the chips, the commits section) need to
 * know.
 */
export function isMainCompositionBuild(targets: readonly string[]): boolean {
  return targets.length === 1 && targets[0] === MAIN_COMPOSITION_ID;
}

/**
 * The durable log channel every build writes to. One spelling shared by the
 * server that creates the channel and the two surfaces that subscribe to it —
 * a renamed channel is then a type error rather than a viewer that silently
 * shows nothing.
 */
export const BUILD_LOG_CHANNEL = "build";
