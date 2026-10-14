import type { Check } from "@plugins/framework/plugins/tooling/core";
import {
  compositionFilteredRegistries,
  renderEmptyCollectedDirRegistry,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { join } from "node:path";
import {
  FIXED_ENTRIES,
  registryRedirectPlugin,
  type RegistryRedirects,
} from "../shared/entrypoints";

/**
 * A release compiles the launcher, pg-start, pgbouncer-start and teardown with
 * `bun build --compile`, which bundles every npm package they reach — and some
 * packages cannot be bundled at all: `playwright-core` requires a
 * `chromium-bidi` that is not installed, so reaching it fails the compile.
 * Twice that surfaced only at deploy time, minutes into a release (2026-08-28
 * through the backend, 2026-10-14 through the launcher reaching the unfiltered
 * deps registry).
 *
 * What a composition contributes reaches these entrypoints only through the
 * composition-filtered registries, which a release resolves to the
 * composition's own. Everything else in their closure is the same for every
 * release, so this check bundles each entrypoint for real — npm resolved, as
 * the compile does — with those registries EMPTY: a failure here is one every
 * release would hit, caught at build time instead.
 */
const fixedEntrypointsBundleCheck: Check = {
  id: "release:fixed-entrypoints-bundle",
  description:
    "the launcher, pg-start, pgbouncer-start and teardown bundle with every npm package resolved (composition registries empty) — what `release` compiles for every composition",
  async run() {
    const root = await getWorktreeRoot();
    const redirects: RegistryRedirects = new Map(
      compositionFilteredRegistries(root).map(({ def, committed }) => [
        committed,
        {
          kind: "contents",
          contents: renderEmptyCollectedDirRegistry(def.dir),
        },
      ]),
    );
    const failures: string[] = [];
    for (const [name, entry] of Object.entries(FIXED_ENTRIES)) {
      const result = await Bun.build({
        entrypoints: [join(root, entry)],
        target: "bun",
        plugins: [registryRedirectPlugin(redirects)],
        // Report, don't throw: the logs ARE the finding.
        throw: false,
      });
      if (!result.success) {
        failures.push(
          `${name} (${entry}):\n    ${result.logs.map(String).join("\n    ")}`,
        );
      }
    }
    if (failures.length === 0) return { ok: true };
    return {
      ok: false,
      message: failures.join("\n  "),
      hint:
        "Find what pulls the unresolvable package in (importClosure's importChain, framework/tooling/import-closure) " +
        "and cut that edge: a host-only feature (Playwright, a dev tool) must not be reachable from a release " +
        "entrypoint except through a composition-filtered registry.",
    };
  },
};

export default [fixedEntrypointsBundleCheck];
