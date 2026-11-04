import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { dirname } from "node:path";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import type { ExecContext } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import {
  sameTarget,
  targetLabel,
  type Dep,
  type DepSource,
  type DepTarget,
} from "./dep";
import { dirBytes, installInCache, writeJsonAtomic } from "./ensure";
import {
  readSealedManifest,
  SEALED_MANIFEST,
  sealedPayloadDir,
  type SealedManifest,
} from "./sealed";
import { defaultStore, type DepStore } from "./store";

/** What {@link sealDep} did with one dependency. */
export type SealOutcome =
  | { kind: "sealed"; identity: string; dir: AppPath; bytes: number }
  /** An optional dependency the kind cannot produce for this target. */
  | { kind: "left-out"; reason: string };

/**
 * Seal `dep` into the release bundle at `outDir`, built for `target`: install
 * it FOR that target (`source.forTarget`), copy the payload to
 * `<outDir>/deps/<id>/`, and record its identity in `<outDir>/deps.sealed.json`.
 * At run time the engine reads a bundle's dependencies from that manifest
 * instead of deriving them — a bundle has no source, toolchain or network.
 *
 * The install goes through the host cache under the target's own identity (it
 * names the target, so a cross-build never shares a host install's identity):
 * the same lock, log and `ready.json` as any install, and a second release for
 * the same target and source reuses it.
 *
 * A target the kind cannot produce throws for a `"required"` dependency and is
 * recorded as left out (with its reason) for an `{ optional }` one.
 */
export async function sealDep(
  dep: Dep<DepSource>,
  opts: {
    target: DepTarget;
    outDir: AppPath;
    exec: ExecContext;
    /** The checkout to build from. Default: this one. */
    root?: AppPath;
    log?: (line: string) => void;
    /** Test seam: the cache and lock dirs. */
    store?: DepStore;
  },
): Promise<SealOutcome> {
  const { target, outDir, exec } = opts;
  const root = opts.root ?? REPO_ROOT;
  const say = opts.log ?? (() => {});
  if (dep.bundle === null || dep.source.forTarget === undefined) {
    throw new Error(
      `sealDep(${dep.id}): the declaration does not say \`bundle\`, so no bundle carries it.`,
    );
  }

  const targeted = dep.source.forTarget(target);
  if (!targeted.ok) {
    if (dep.bundle === "required") {
      throw new Error(
        `${dep.id} is required in every bundle, but cannot be built for ${targetLabel(target)}: ${targeted.reason}`,
      );
    }
    const reason = `${targeted.reason} (${dep.bundle.optional})`;
    updateManifest(outDir, target, (m) => {
      delete m.deps[dep.id];
      m.unsealed[dep.id] = reason;
    });
    return { kind: "left-out", reason };
  }

  const { identity, paths } = await installInCache(dep, targeted.source, exec, {
    root,
    store: opts.store ?? defaultStore(),
    say,
  });
  const rel = sealedPayloadDir(dep.id);
  const dir = joinAppPath(outDir, rel);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(paths.env, dir, { recursive: true, verbatimSymlinks: true });
  const bytes = dirBytes(dir);
  updateManifest(outDir, target, (m) => {
    m.deps[dep.id] = { kind: targeted.source.kind, identity, dir: rel, bytes };
    delete m.unsealed[dep.id];
  });
  return { kind: "sealed", identity, dir, bytes };
}

function updateManifest(
  outDir: AppPath,
  target: DepTarget,
  edit: (m: SealedManifest) => void,
): void {
  const path = joinAppPath(outDir, SEALED_MANIFEST);
  const manifest: SealedManifest = existsSync(path)
    ? readSealedManifest(path)
    : {
        version: 1,
        target: { platform: target.platform, arch: target.arch },
        deps: {},
        unsealed: {},
      };
  if (!sameTarget(manifest.target as DepTarget, target)) {
    throw new Error(
      `${path} seals a bundle for ${targetLabel(manifest.target as DepTarget)}; cannot add a ${targetLabel(target)} payload to it`,
    );
  }
  edit(manifest);
  mkdirSync(outDir, { recursive: true });
  writeJsonAtomic(path, manifest);
}
