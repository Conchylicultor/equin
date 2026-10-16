// The workspace as the npm updater and its checks read it: every package.json
// (its declared dependencies and its `dependencyPolicy`) and what `bun.lock`
// resolved each to. Read-only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { POLICY_KEY, PolicySchema, type Policy } from "./policy";
import { parseSpec, type Spec } from "./spec";

/**
 * The sections a workspace installs from. `peerDependencies` is not one: a peer
 * range states compatibility for consumers and is legitimately wide (`>=18`).
 */
export const SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;
export type Section = (typeof SECTIONS)[number];

/** One dependency as one package.json declares it. */
export interface Declared {
  /** Repo-relative path of the package.json. */
  manifest: string;
  /** Its `name` — the key `bun.lock` scopes a non-hoisted copy under. */
  workspace: string;
  section: Section;
  name: string;
  raw: string;
  spec: Spec;
}

/** A package.json whose `dependencyPolicy` did not parse. */
export interface PolicyError {
  manifest: string;
  message: string;
}

export interface DeclaredPolicy {
  manifest: string;
  policy: Policy;
}

/** What `bun.lock` resolved, read once. */
export interface Lock {
  /** The version the workspace named `workspace` gets for `name`. */
  resolved(workspace: string, name: string): string | undefined;
  /** Every version of `name` anywhere in the lock: more than one is two copies. */
  copies(name: string): Set<string>;
  /** Packages under `patchedDependencies`: name → the patched version and its patch file. */
  patched: ReadonlyMap<string, { version: string; patch: string }>;
}

export interface Workspace {
  declared: Declared[];
  policies: DeclaredPolicy[];
  policyErrors: PolicyError[];
  lock: Lock;
}

const ManifestSchema = z
  .object({
    name: z.string().optional(),
    dependencies: z.record(z.string()).optional(),
    devDependencies: z.record(z.string()).optional(),
    optionalDependencies: z.record(z.string()).optional(),
    [POLICY_KEY]: z.unknown().optional(),
  })
  .passthrough();

const LockSchema = z.object({
  workspaces: z.record(z.object({ name: z.string().optional() }).passthrough()),
  patchedDependencies: z.record(z.string()).optional(),
  // `[ "<name>@<version>", registry, info, integrity ]` (a workspace link is
  // `[ "<name>@workspace:<path>" ]`).
  packages: z.record(z.array(z.unknown()).min(1)),
});

/** Every workspace package.json: the root and each plugin's, tracked or new. */
export async function workspaceManifests(root: string): Promise<string[]> {
  const result = await spawnCaptured(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "package.json",
      ":(glob)plugins/**/package.json",
    ],
    { cwd: root, timeoutMs: 60_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.split("\n").filter((l) => l.trim() !== "");
}

/** The version in a lock entry's `<name>@<version>` ident (scoped names keep their `@`). */
function identVersion(ident: string): string {
  return ident.slice(ident.lastIndexOf("@") + 1);
}

/** The package name a lock key ends in: `a/b/@s/p` → `@s/p`, `x/p` → `p`. */
function keyName(key: string): string {
  const parts = key.split("/");
  const last = parts.at(-1)!;
  const prev = parts.at(-2);
  return prev?.startsWith("@") ? `${prev}/${last}` : last;
}

export function parseLock(text: string): Lock {
  const errors: ParseError[] = [];
  const raw: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(
      `bun.lock does not parse: ${errors.map((e) => `${printParseErrorCode(e.error)} at ${e.offset}`).join(", ")}`,
    );
  }
  const lock = LockSchema.parse(raw);
  const versionAt = (key: string): string | undefined => {
    const ident = lock.packages[key]?.[0];
    if (typeof ident !== "string" || ident.includes("@workspace:"))
      return undefined;
    return identVersion(ident);
  };
  const copies = new Map<string, Set<string>>();
  for (const key of Object.keys(lock.packages)) {
    const v = versionAt(key);
    if (v === undefined) continue;
    const name = keyName(key);
    copies.set(name, (copies.get(name) ?? new Set()).add(v));
  }
  const patched = new Map<string, { version: string; patch: string }>();
  for (const [ident, patch] of Object.entries(lock.patchedDependencies ?? {})) {
    patched.set(ident.slice(0, ident.lastIndexOf("@")), {
      version: identVersion(ident),
      patch,
    });
  }
  return {
    resolved: (workspace, name) =>
      versionAt(`${workspace}/${name}`) ?? versionAt(name),
    copies: (name) => copies.get(name) ?? new Set(),
    patched,
  };
}

export async function readWorkspace(root: string): Promise<Workspace> {
  const declared: Declared[] = [];
  const policies: DeclaredPolicy[] = [];
  const policyErrors: PolicyError[] = [];
  for (const manifest of await workspaceManifests(root)) {
    const pkg = ManifestSchema.parse(
      JSON.parse(readFileSync(join(root, manifest), "utf8")),
    );
    const workspace = pkg.name ?? manifest;
    for (const section of SECTIONS) {
      for (const [name, raw] of Object.entries(pkg[section] ?? {})) {
        declared.push({
          manifest,
          workspace,
          section,
          name,
          raw,
          spec: parseSpec(raw),
        });
      }
    }
    if (pkg[POLICY_KEY] !== undefined) {
      const parsed = PolicySchema.safeParse(pkg[POLICY_KEY]);
      if (parsed.success) policies.push({ manifest, policy: parsed.data });
      else
        policyErrors.push({
          manifest,
          message: parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
    }
  }
  return {
    declared,
    policies,
    policyErrors,
    lock: parseLock(readFileSync(join(root, "bun.lock"), "utf8")),
  };
}

/**
 * Every directly declared registry package (workspace links skipped) with the
 * version the lock gives it — the newest across the workspaces declaring it,
 * since a move rewrites all of their specs at once.
 */
export function installedVersions(
  ws: Workspace,
): { name: string; current: string }[] {
  const current = new Map<string, string>();
  for (const d of ws.declared) {
    if (d.spec.kind === "workspace") continue;
    const v = ws.lock.resolved(d.workspace, d.name);
    if (v === undefined)
      throw new Error(
        `bun.lock resolves nothing for ${d.name} (${d.manifest}) — run \`bun install\`.`,
      );
    const seen = current.get(d.name);
    if (seen === undefined || Bun.semver.order(v, seen) > 0)
      current.set(d.name, v);
  }
  return [...current].map(([name, v]) => ({ name, current: v }));
}
