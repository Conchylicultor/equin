// The workspace as the npm updater and its checks read it: every package.json
// (its declared dependencies and its `dependencyPolicy`) and what `bun.lock`
// resolved each to. Read-only.

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { foldRepoFiles } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { PolicySchema, type Policy } from "./policy";
import { parseSpec, type Spec } from "./spec";
import { manifestsFold, SECTIONS } from "./manifests.scan";

export { SECTIONS };

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

const LockSchema = z.object({
  workspaces: z.record(
    z.string(),
    z.object({ name: z.string().optional() }).passthrough(),
  ),
  patchedDependencies: z.record(z.string(), z.string()).optional(),
  // `[ "<name>@<version>", registry, info, integrity ]` (a workspace link is
  // `[ "<name>@workspace:<path>" ]`).
  packages: z.record(z.string(), z.array(z.unknown()).min(1)),
});

/**
 * Every workspace package.json: the root and each plugin's, tracked or new —
 * as the working tree has them (the file set subtracts one deleted but not yet
 * committed: a plugin just removed). Read off the caller's file set — a check
 * run's `ctx.repo()`, so the four `deps-npm:*` checks no longer each walk
 * `plugins/` for untracked manifests.
 */
export function workspaceManifests(files: RepoFiles): string[] {
  return [
    ...(files.has("package.json") ? ["package.json"] : []),
    ...files
      .glob("plugins/**/package.json")
      .filter((path) => path.endsWith("/package.json")),
  ];
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

/** The workspace as `files` holds it: every manifest of {@link workspaceManifests}, and `bun.lock`. */
export async function readWorkspace(files: RepoFiles): Promise<Workspace> {
  const declared: Declared[] = [];
  const policies: DeclaredPolicy[] = [];
  const policyErrors: PolicyError[] = [];
  // Each manifest's part is a plugin record (`manifestsFold`): a pass parses
  // only the manifests whose bytes it has not folded yet, where every reader
  // of the workspace (four checks, the updater) read all ~1.8k on every pass.
  // The fold hands its parts in tree order; they are put back in the order of
  // `workspaceManifests` (the root first, then the set's own sort).
  const manifests = workspaceManifests(files);
  const order = new Map(manifests.map((m, i) => [m, i]));
  const parts = (
    await foldRepoFiles(files, manifests, manifestsFold, null)
  ).sort((a, b) => order.get(a.manifest)! - order.get(b.manifest)!);
  for (const part of parts) {
    const { manifest } = part;
    const workspace = part.name ?? manifest;
    for (const { section, name, raw } of part.deps) {
      declared.push({
        manifest,
        workspace,
        section,
        name,
        raw,
        spec: parseSpec(raw),
      });
    }
    if (part.policy !== undefined) {
      const parsed = PolicySchema.safeParse(part.policy.raw);
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
    lock: parseLock(await readMember(files, "bun.lock")),
  };
}

/** A member's text; one gone since the set was taken is a failure, never "no manifest". */
async function readMember(files: RepoFiles, path: string): Promise<string> {
  const text = await files.read(path);
  if (text === null) {
    throw new Error(
      `${path} is not a file of the working tree at ${files.root} (removed since the file set was taken, or never there).`,
    );
  }
  return text;
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
