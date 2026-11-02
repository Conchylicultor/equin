import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  hostTarget,
  mintReady,
  sameTarget,
  targetLabel,
  type Dep,
  type DepSource,
  type DepTarget,
  type Ready,
} from "./dep";

/**
 * The file at a release bundle's root naming every dependency sealed into it.
 * Its presence at the root the engine reads from is what makes that root a
 * sealed bundle: nothing there is derived or installed, it is all read.
 */
export const SEALED_MANIFEST = "deps.sealed.json";

/** Where a sealed dependency's payload sits in a bundle, relative to its root. */
export function sealedPayloadDir(id: string): string {
  return join("deps", id);
}

export const SealedManifestSchema = z.object({
  version: z.literal(1),
  /** The platform the bundle was built for; every payload in it is for this one. */
  target: z.object({ platform: z.string(), arch: z.string() }),
  deps: z.record(
    z.string(),
    z.object({
      kind: z.string(),
      /** The identity `sealDep` installed — the same one the host cache would name. */
      identity: z.string(),
      /** The payload (a `Ready.dir`), relative to the bundle root. */
      dir: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  /** Optional dependencies left out of this bundle, with why. */
  unsealed: z.record(z.string(), z.string()),
});
export type SealedManifest = z.infer<typeof SealedManifestSchema>;

export function readSealedManifest(path: string): SealedManifest {
  return SealedManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** What a root says about `dep` when it is (or is not) a sealed bundle. */
export type SealedLookup<S extends DepSource> =
  /** No manifest: a checkout, where the identity is derived as usual. */
  | { kind: "unsealed" }
  | { kind: "ready"; ready: Ready<S>; bytes: number }
  /** A bundle that cannot provide it — nothing can install it there. */
  | { kind: "failed"; message: string };

/**
 * `dep` as the sealed bundle at `root` holds it. Cheap (one small JSON read)
 * and synchronous, so safe on an event loop and on every engine entry point.
 *
 * A bundle runs on the platform it was built for; one read on another is a
 * failure, never a payload that would not load.
 */
export function sealedLookup<S extends DepSource>(
  dep: Dep<S>,
  root: AppPath,
  host: DepTarget = hostTarget(),
): SealedLookup<S> {
  const path = joinAppPath(root, SEALED_MANIFEST);
  if (!existsSync(path)) return { kind: "unsealed" };
  const manifest = readSealedManifest(path);
  const target = manifest.target as DepTarget;
  if (!sameTarget(target, host)) {
    return {
      kind: "failed",
      message: `${root} is a bundle sealed for ${targetLabel(target)}, read on ${targetLabel(host)}`,
    };
  }
  const entry = manifest.deps[dep.id];
  if (entry === undefined) {
    const left = manifest.unsealed[dep.id];
    return {
      kind: "failed",
      message:
        left !== undefined
          ? `${dep.id} was left out of this bundle: ${left}`
          : `${dep.id} is not sealed into this bundle (${root}), which has no source or toolchain to install it — only a declaration with \`bundle\` is`,
    };
  }
  const dir = joinAppPath(root, entry.dir);
  if (!existsSync(dir) || !(dep.source.isIntact?.(dir) ?? true)) {
    return {
      kind: "failed",
      message: `${dep.id}'s sealed payload is missing or incomplete at ${dir}`,
    };
  }
  return {
    kind: "ready",
    ready: mintReady(dep, dir, entry.identity),
    bytes: entry.bytes,
  };
}
