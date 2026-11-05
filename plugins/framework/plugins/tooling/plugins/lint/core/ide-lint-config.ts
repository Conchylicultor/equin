import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { Linter } from "eslint";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import { buildLintConfig } from "./build-lint-config";

/**
 * The editor's config (`eslint.config.ts`): every rule, types from each file's
 * own tsconfig (`projectService`), and each exempted (rule, path) switched off
 * so an exempt file shows no squiggle. ESLint loads it once per session, so the
 * session is its own pass: the manifests are read off one listing of the repo,
 * taken here.
 */
export async function buildIdeLintConfig(
  root: AppPath,
): Promise<Linter.Config[]> {
  return buildLintConfig({
    root,
    typeSource: { projectService: true },
    exemptions: { mode: "config-off", manifests: await loadRepoFiles(root) },
  });
}
