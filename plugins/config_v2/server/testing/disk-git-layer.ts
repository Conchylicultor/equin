import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServerContribution } from "@plugins/framework/plugins/server-core/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { committedDocument, committedFilesFromMap } from "../../core";
import { ConfigGitLayer } from "../internal/host-services";

/** The repo's `config/`, read off disk: what a worker's bundled layer inlines. */
function diskConfigFiles(): Map<string, string> {
  const dir = join(REPO_ROOT, "config");
  const files = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    if (!rel.endsWith(".jsonc") || !statSync(join(dir, rel)).isFile()) continue;
    files.set(rel, readFileSync(join(dir, rel), "utf8"));
  }
  return files;
}

/**
 * The committed config layer a browser host bundles (`config_v2/bundled-layer`,
 * which reads it through vite's `import.meta.glob` — absent under `bun test`),
 * provided from the same files read off disk: for a suite booting a portable
 * graph without the computer. Unwatched: the committed layer does not move
 * under a test.
 */
export function diskConfigGitLayer(): ServerContribution {
  const committedFiles = committedFilesFromMap(diskConfigFiles());
  return ConfigGitLayer.provide({
    document: (storePath) => committedDocument(storePath, committedFiles),
    watch: () => Promise.resolve(() => {}),
  });
}
