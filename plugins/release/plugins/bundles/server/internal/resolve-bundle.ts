import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { basename, join } from "node:path";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { ReleaseManifestSchema } from "../../core";
import type { BundleResolution } from "../../core";
import {
  bundleRoot,
  isPointerName,
  latestPointerName,
  latestPointerPath,
} from "./pointer";
import {
  type AppPath,
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * Resolve which bundle to ship for `(composition, platform)`.
 *
 * The canonical filesystem layout IS the registry (see
 * `plugins/release/CLAUDE.md`, §Discovery) — there is no DB query: run dirs
 * under {@link bundleRoot}, a `latest-<platform>` symlink at the current packed
 * one, and a self-describing `RELEASE.json` inside each.
 *
 * Every manifest field is cross-checked against something ELSE that knows it, so
 * a mismatch is caught here — loudly, by name — rather than at `systemctl
 * start`, where it would present as a crash loop.
 *
 * Failure is a `{ ok: false, refusal }` value, not an exit: this is asked both
 * by the CLI (which prints and exits) and by an HTTP handler (which cannot).
 * A *corrupt* RELEASE.json is not in that union — `ReleaseManifestSchema.parse`
 * throws, because a broken artifact is not a refusal a user can act on.
 */
export function resolveBundle(opts: {
  /**
   * WHO produced the release being looked for — a backend's own runtime
   * namespace, or, in a CLI, the namespace the invoking checkout owns. Stated by
   * the caller because those are different questions; see {@link bundleRoot}.
   */
  namespace: Namespace;
  composition: string;
  platform: string;
  release?: string;
}): BundleResolution {
  const { composition, platform } = opts;
  const { namespace, compDir } = bundleRoot(opts.namespace, composition);
  if (!existsSync(compDir)) {
    return {
      ok: false,
      refusal: {
        kind: "no-releases",
        composition,
        platform,
        compDir,
        namespace,
      },
    };
  }

  let runDir: AppPath;
  if (opts.release !== undefined) {
    runDir = joinAppPath(compDir, opts.release);
    if (!existsSync(runDir)) {
      return {
        ok: false,
        refusal: {
          kind: "no-such-run",
          release: opts.release,
          runDir,
          compDir,
          available: readdirSync(compDir).filter((d) => !isPointerName(d)),
          namespace,
        },
      };
    }
  } else {
    const pointerPath = latestPointerPath(compDir, platform);
    if (!existsSync(pointerPath)) {
      return {
        ok: false,
        refusal: {
          kind: "no-pointer",
          pointer: latestPointerName(platform),
          pointerPath,
          namespace,
        },
      };
    }
    // The real path of the pointer symlink under the composition dir.
    runDir = asAppPath(realpathSync(pointerPath));
  }

  const manifestPath = join(runDir, "RELEASE.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, refusal: { kind: "no-manifest", runDir } };
  }
  const manifest = ReleaseManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );

  if (manifest.composition !== composition) {
    return {
      ok: false,
      refusal: {
        kind: "wrong-composition",
        manifestPath,
        found: manifest.composition,
        expected: composition,
      },
    };
  }
  if (manifest.target !== "web") {
    return {
      ok: false,
      refusal: { kind: "wrong-target", manifestPath, found: manifest.target },
    };
  }
  // The platform is DISCOVERED on both sides — the release's own record of what
  // it built, and the server's own `uname`. Comparing two observed facts leaves
  // no third place for a human to have typed it wrong.
  if (manifest.platform !== platform) {
    return {
      ok: false,
      refusal: {
        kind: "platform-mismatch",
        manifestPath,
        found: manifest.platform,
        expected: platform,
      },
    };
  }
  const runId = basename(runDir);
  if (manifest.runId !== runId) {
    return {
      ok: false,
      refusal: {
        kind: "inconsistent-run-id",
        manifestPath,
        declared: manifest.runId,
        runId,
      },
    };
  }

  const binaryName = bundleBinaryName(composition, platform);
  const localPath = joinAppPath(runDir, "dist", binaryName);
  if (!existsSync(localPath)) {
    return { ok: false, refusal: { kind: "not-packed", localPath } };
  }
  return { ok: true, runId, localPath, binaryName, manifest };
}

/**
 * The packed binary's file name inside a run's `dist/` — the one spelling
 * {@link resolveBundle} and {@link bundleSignature} both read.
 */
function bundleBinaryName(composition: string, platform: string): string {
  return `${composition}-web-${platform}`;
}

/**
 * A cheap fingerprint of every filesystem fact {@link resolveBundle} reads for
 * `(composition, platform)` — when it is unchanged, `resolveBundle` would
 * return the same verdict. No parse, no directory listing: a handful of
 * `stat`s and one `realpath`, so a caller can probe it on every read and run
 * the real resolution only when it moved (the release candidate's signed memo).
 *
 * Covered, in the order `resolveBundle` meets them:
 *
 * - whether the composition directory exists (`no-releases`);
 * - where `latest-<platform>` resolves to, or that it does not (`no-pointer`);
 * - the run's `RELEASE.json` mtime and size (`no-manifest`, and every check
 *   the manifest's fields feed — a rewrite moves at least the mtime);
 * - whether `dist/<comp>-web-<platform>` exists (`not-packed`).
 *
 * It does not cover an explicit `release` — the candidate is always the
 * pointer's run, and that is the only question this answers. DB-free, like
 * everything in this plugin, so a CLI process can import it.
 */
export function bundleSignature(opts: {
  namespace: Namespace;
  composition: string;
  platform: string;
}): string {
  const { composition, platform } = opts;
  const { compDir } = bundleRoot(opts.namespace, composition);
  if (!existsSync(compDir)) return "no-releases";
  const pointerPath = latestPointerPath(compDir, platform);
  if (!existsSync(pointerPath)) return "no-pointer";
  const runDir = asAppPath(realpathSync(pointerPath));
  const manifest = statSync(joinAppPath(runDir, "RELEASE.json"), {
    throwIfNoEntry: false,
  });
  const packed = existsSync(
    joinAppPath(runDir, "dist", bundleBinaryName(composition, platform)),
  );
  return [
    runDir,
    manifest === undefined
      ? "no-manifest"
      : `${manifest.mtimeMs}:${manifest.size}`,
    packed ? "packed" : "not-packed",
  ].join("\0");
}
