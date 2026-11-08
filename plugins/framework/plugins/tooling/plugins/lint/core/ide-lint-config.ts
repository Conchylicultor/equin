import type { Linter } from "eslint";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import type { ManifestSource } from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import { buildLintConfig } from "./build-lint-config";
import { readDeclaredUtilities } from "./declared-utilities";

/**
 * The editor's config (`eslint.config.ts`): every rule, types from each file's
 * own tsconfig (`projectService`), and each exempted (rule, path) switched off
 * so an exempt file shows no squiggle. ESLint loads it once per session, so the
 * session is its own pass: the manifests are read off one listing, taken here.
 *
 * Takes no argument: the root is this checkout's `REPO_ROOT`, so the config
 * file has nothing to hand in — and so nothing to import from `@plugins/*`,
 * which ESLint's own loader cannot resolve.
 *
 * Runs under NODE: the editor's ESLint server is a Node process, so nothing
 * here may reach Bun-only code (`Bun.spawn`, `bun:ffi`) — which is why the
 * manifests are not read off tooling/core's `loadRepoFiles` (its git runs
 * through infra/spawn). `lint:eslint-config-loads` loads this through ESLint's
 * own CLI under Node, so a Bun-only import anywhere below fails that check.
 */
export async function buildIdeLintConfig(): Promise<Linter.Config[]> {
  return buildLintConfig({
    root: REPO_ROOT,
    typeSource: { projectService: true },
    exemptions: { mode: "config-off", manifests: await manifestFiles() },
    declaredUtilities: readDeclaredUtilities(REPO_ROOT),
  });
}

const MANIFEST_PATHSPEC = "plugins/**/exempt/index.ts";

/**
 * The exemption manifests on disk, as the `ManifestSource` the loader reads:
 * git's listing (tracked and untracked-unignored, minus deleted — the same
 * membership as `loadRepoFiles`) narrowed to the manifest pathspec, so the
 * session lists a few hundred paths, not the tree.
 */
async function manifestFiles(): Promise<ManifestSource> {
  const [present, deleted] = await Promise.all([
    lsFiles(["--cached", "--others", "--exclude-standard"]),
    lsFiles(["--deleted"]),
  ]);
  const gone = new Set(deleted);
  const paths = [...new Set(present.filter((p) => !gone.has(p)))].sort();
  return {
    root: REPO_ROOT,
    glob(pattern) {
      if (pattern !== MANIFEST_PATHSPEC) {
        throw new Error(
          `ide-lint-config: listed ${MANIFEST_PATHSPEC} only, asked for ${pattern}`,
        );
      }
      return paths;
    },
  };
}

async function lsFiles(args: string[]): Promise<string[]> {
  const { stdout } = await promisify(execFile)(
    "git",
    ["ls-files", "-z", ...args, "--", MANIFEST_PATHSPEC],
    { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout.split("\0").filter((p) => p.length > 0);
}
