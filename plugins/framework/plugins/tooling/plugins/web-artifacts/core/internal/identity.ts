// The global builder identity: everything that changes EVERY artifact's output
// without being any plugin's own file. Toolchain versions, the babel
// contribution set (react-compiler, element-picker, …), the minify flag, and
// the versions of inline-allowlisted packages (their code is bundled INTO
// consumers, so their version is an input of every artifact).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findViteContributions } from "@plugins/framework/plugins/web-core/core";
import { BUILDER_VERSION, INLINE_PACKAGES } from "../constants";
import { computeIdentityHash, computeOwnHash, sha256Hex } from "../hash";
import { listOwnFiles, readFilesBounded } from "./own-files";

const require = createRequire(import.meta.url);

/**
 * A package's resolved version. Resolution root matters under bun's isolated
 * installs: toolchain packages (vite, esbuild, tailwind) are THIS plugin's own
 * deps — omit `fromDir` so they resolve from here; a consumer-side package must
 * pass the dir whose package.json declares it.
 *
 * One small `package.json` read per call — not the whole-tree walk
 * `listOwnFiles`/`builderSourceDigest` do below — so it stays sync.
 */
export function packageVersion(pkg: string, fromDir?: string): string {
  const resolver = fromDir
    ? createRequire(join(fromDir, "package.json"))
    : require;
  const pj = resolver.resolve(`${pkg}/package.json`);
  return (JSON.parse(readFileSync(pj, "utf8")) as { version: string }).version;
}

export interface BuilderIdentity {
  identityHash: string;
  /** Content hash of THIS plugin's own `core/` source (see builderSourceDigest). */
  sourceDigest: string;
  /** Human-readable record kept for debugging (written into the manifest). */
  record: Record<string, string | number | boolean>;
}

const WEB_ARTIFACTS_REL = "framework/plugins/tooling/plugins/web-artifacts";

/**
 * Content hash of the builder's OWN implementation (this plugin's `core/`
 * subtree + `package.json`, tests excluded). The builder's code is an input of
 * every artifact — a scanner/compose/vite-wiring change alters outputs (or
 * their recorded metadata) without touching any plugin's files, and the
 * content-addressed store would silently reuse stale artifacts. Hashing the
 * source here auto-invalidates the fleet on ANY builder edit, so
 * `BUILDER_VERSION` is only a forced-bump lever, never a thing to remember.
 */
export async function builderSourceDigest(
  pluginsRoot: string,
): Promise<string> {
  const pluginDir = join(pluginsRoot, WEB_ARTIFACTS_REL);
  const absFiles = await listOwnFiles(pluginDir, "core");
  if (absFiles.length === 0) {
    throw new Error(
      `builder identity: no own files found under ${pluginDir}/core`,
    );
  }
  const files = await readFilesBounded(absFiles, (abs, content) => ({
    rel: abs.slice(pluginDir.length + 1),
    content,
  }));
  return computeOwnHash(files);
}

/**
 * Assemble the identity hash. Babel contributions are identified by the sha256
 * of each discovered `vite/index.ts` plus its plugin's `package.json` (which
 * pins the transform package version, e.g. `babel-plugin-react-compiler`).
 */
export async function computeBuilderIdentity(opts: {
  repoRoot: string;
  pluginsRoot: string;
  minify: boolean;
}): Promise<BuilderIdentity> {
  // Versions come from package.json reads (require.resolve), NOT module
  // imports — loading vite/esbuild here would put ~1s of module eval on every
  // pipeline run's detect stage (and on docgen's barrel import).
  const sourceDigest = await builderSourceDigest(opts.pluginsRoot);
  const record: Record<string, string | number | boolean> = {
    builderVersion: BUILDER_VERSION,
    builderSource: sourceDigest,
    minify: opts.minify,
    vite: packageVersion("vite"),
    esbuild: packageVersion("esbuild"),
    pluginReact: packageVersion("@vitejs/plugin-react"),
    // Extracts every artifact's Tailwind candidates (`tailwind-candidates.ts`).
    tailwindOxide: packageVersion("@tailwindcss/oxide"),
  };
  for (const pkg of INLINE_PACKAGES) {
    record[`inline:${pkg}`] = packageVersion(pkg, opts.repoRoot);
  }
  for (const file of await findViteContributions(opts.pluginsRoot)) {
    const rel = file.slice(opts.pluginsRoot.length + 1);
    let digest = sha256Hex(await readFile(file));
    const pkgJson = join(file, "..", "..", "package.json");
    try {
      digest = sha256Hex(digest + (await readFile(pkgJson, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    record[`babel:${rel}`] = digest;
  }
  return { identityHash: computeIdentityHash(record), sourceDigest, record };
}
