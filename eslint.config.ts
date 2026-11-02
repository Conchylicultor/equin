import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
/**
 * Repo ESLint config — for the editor/IDE integration and ad-hoc `bunx eslint`.
 *
 * The rules, plugin contributions, and per-rule exemptions all live in the
 * shared builder `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts`,
 * so this config and the `type-check` check (which builds the same config but
 * reuses a pre-built TypeScript program) can never drift. This file only picks
 * the parser's type source: `projectService: true`, which discovers each file's
 * tsconfig. A file that resolves to no project errors loudly.
 *
 * ESLint loads this file through its own jiti, which knows nothing of the
 * tsconfig `@plugins/*` alias. So the builder is loaded through a SECOND jiti
 * created here with that alias: everything the builder reaches — lint core, the
 * exempt primitive, every lint barrel and rule — then resolves `@plugins/*`
 * exactly as Bun does for the type-check worker, and no file below has to stay
 * alias-free for this one loader's sake.
 *
 * `exemptions: "config-off"`: an exempted file gets the rule switched off in
 * the config, so the editor shows no squiggle there. The type-check worker uses
 * the `"report"` mode instead, which also catches an exemption that suppresses
 * nothing. Both modes read the same manifests through one loader.
 */

import type { Linter } from "eslint";
import { createJiti } from "jiti";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { buildLintConfig as BuildLintConfig } from "./plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config";

const here = dirname(fileURLToPath(import.meta.url));

const jiti = createJiti(import.meta.url, {
  alias: { "@plugins": join(here, "plugins") },
});
const { buildLintConfig } = await jiti.import<{
  buildLintConfig: typeof BuildLintConfig;
}>(
  join(
    here,
    "plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts",
  ),
);

// Annotated so the declaration emitter can name the export through eslint's
// public types rather than a non-portable path into `@eslint/core` (TS2883).
const config: Linter.Config[] = await buildLintConfig({
  root: asAppPath(here),
  typeSource: { projectService: true },
  exemptions: "config-off",
});

export default config;
