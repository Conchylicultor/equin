// The global builder identity: everything that changes EVERY artifact's output
// without being any plugin's own file. Toolchain versions, the babel
// contribution set (react-compiler, element-picker, …), the minify flag, and
// the versions of inline-allowlisted packages (their code is bundled INTO
// consumers, so their version is an input of every artifact).

import { createRequire } from "node:module";
import {
  appPathParent,
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { relative } from "node:path";
import { isViteContributionPath } from "@plugins/framework/plugins/web-core/core";
import type { RepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { BUILDER_VERSION, INLINE_PACKAGES } from "../constants";
import { computeBlobListHash, computeIdentityHash, sha256Hex } from "../hash";
import { listOwnFiles } from "./own-files";

const require = createRequire(import.meta.url);

/**
 * A package's resolved version. Resolution root matters under bun's isolated
 * installs: toolchain packages (vite, esbuild, tailwind) are THIS plugin's own
 * deps — omit `fromDir` so they resolve from here; a consumer-side package must
 * pass the dir whose package.json declares it.
 *
 * One small `package.json` read per call, so it stays sync.
 */
export function packageVersion(pkg: string, fromDir?: AppPath): string {
  const resolver = fromDir
    ? createRequire(joinAppPath(fromDir, "package.json"))
    : require;
  // The package.json of a package this app's own install resolved.
  const pj = asAppPath(resolver.resolve(`${pkg}/package.json`));
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
export function builderSourceDigest(
  snapshot: RepoSnapshot,
  pluginsRoot: AppPath,
): string {
  const pluginDir = joinAppPath(pluginsRoot, WEB_ARTIFACTS_REL);
  const absFiles = listOwnFiles(snapshot, pluginDir, "core");
  if (absFiles.length === 0) {
    throw new Error(
      `builder identity: no own files found under ${pluginDir}/core`,
    );
  }
  return computeBlobListHash(
    absFiles.map((abs) => ({
      rel: abs.slice(pluginDir.length + 1),
      blob: snapshot.blobOf(relative(snapshot.root, abs)),
    })),
  );
}

/**
 * Assemble the identity hash. Babel contributions are identified by the blob
 * id of each `vite/index.ts` in the snapshot plus its plugin's `package.json`
 * (which pins the transform package version, e.g.
 * `babel-plugin-react-compiler`).
 */
export function computeBuilderIdentity(opts: {
  snapshot: RepoSnapshot;
  pluginsRoot: AppPath;
  minify: boolean;
}): BuilderIdentity {
  const { snapshot } = opts;
  // Versions come from package.json reads (require.resolve), NOT module
  // imports — loading vite/esbuild here would put ~1s of module eval on every
  // pipeline run's detect stage (and on docgen's barrel import).
  const sourceDigest = builderSourceDigest(snapshot, opts.pluginsRoot);
  const record: Record<string, string | number | boolean> = {
    builderVersion: BUILDER_VERSION,
    builderSource: sourceDigest,
    minify: opts.minify,
    vite: packageVersion("vite"),
    esbuild: packageVersion("esbuild"),
    // Runs the babel contributions (`babel-transform.ts`).
    babelCore: packageVersion("@babel/core"),
    // Extracts every artifact's Tailwind candidates (`tailwind-candidates.ts`).
    tailwindOxide: packageVersion("@tailwindcss/oxide"),
  };
  for (const pkg of INLINE_PACKAGES) {
    record[`inline:${pkg}`] = packageVersion(pkg, snapshot.root);
  }
  const pluginsRel = relative(snapshot.root, opts.pluginsRoot);
  for (const path of snapshot.under(pluginsRel)) {
    const rel = path.slice(pluginsRel.length + 1);
    if (!isViteContributionPath(rel)) continue;
    let digest = snapshot.blobOf(path);
    const pkgJson = relative(
      snapshot.root,
      joinAppPath(
        appPathParent(appPathParent(joinAppPath(opts.pluginsRoot, rel))),
        "package.json",
      ),
    );
    if (snapshot.has(pkgJson)) {
      digest = sha256Hex(`${digest}\n${snapshot.blobOf(pkgJson)}`);
    }
    record[`babel:${rel}`] = digest;
  }
  return { identityHash: computeIdentityHash(record), sourceDigest, record };
}
