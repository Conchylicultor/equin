// What a dependency spec in a package.json says, and the one rewrite the npm
// updater makes to it.

import type { Agree } from "./policy";

/** The spec kinds a workspace may declare: a caret or tilde range, or a workspace link. */
export type AllowedSpec =
  { kind: "range"; op: "^" | "~"; version: string } | { kind: "workspace" };

export type Spec =
  | AllowedSpec
  /** `1.2.3`: an exact pin. The lock already fixes the version; this only stops it moving. */
  | { kind: "exact"; version: string }
  /** Anything else: a dist-tag (`latest`), `*`, `>=`, a git or URL source, an alias. */
  | { kind: "other"; raw: string };

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSpec(raw: string): Spec {
  if (raw.startsWith("workspace:")) return { kind: "workspace" };
  const op = raw[0];
  if ((op === "^" || op === "~") && VERSION.test(raw.slice(1))) {
    return { kind: "range", op, version: raw.slice(1) };
  }
  if (VERSION.test(raw)) return { kind: "exact", version: raw };
  return { kind: "other", raw };
}

/**
 * The range a move to `to` writes: the declared operator over the new floor
 * (`^6.3.2` → `^7.1.0`), so the spec always names the release the lock holds
 * and a new major is a spec change, never a silent reach.
 */
export function rangeAt(
  spec: AllowedSpec & { kind: "range" },
  to: string,
): string {
  return `${spec.op}${to}`;
}

/** `major.minor.patch` of a version, prerelease and build dropped. */
export function versionParts(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (m === null) throw new Error(`Not a version: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isPrerelease(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}

/** The part of `version` that `agree` compares: the whole, `major.minor` or `major`. */
export function agreeKey(version: string, agree: Agree): string {
  const [major, minor] = versionParts(version);
  switch (agree) {
    case "version":
      return version;
    case "major.minor":
      return `${major}.${minor}`;
    case "major":
      return `${major}`;
  }
}
