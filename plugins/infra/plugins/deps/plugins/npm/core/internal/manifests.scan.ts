import { z } from "zod";
import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";

// Every workspace package.json, as read by the npm updater and the `deps-npm:*`
// checks, folded along the directory tree: a manifest's part is a function of
// its bytes alone, so a pass after an edit parses only the edited manifests
// and an unchanged workspace is one record — never the ~1.8k reads every
// reader of the workspace made on every pass. Its records are keyed by this
// module's closure, so an edit to the manifest schema re-folds every file.

/**
 * The sections a workspace installs from. `peerDependencies` is not one: a peer
 * range states compatibility for consumers and is legitimately wide (`>=18`).
 */
export const SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
] as const;

/** The package.json key a `dependencyPolicy` is written under. */
export const POLICY_KEY = "dependencyPolicy";

const ManifestSchema = z
  .object({
    name: z.string().optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    [POLICY_KEY]: z.unknown().optional(),
  })
  .passthrough();

/** What one package.json declares: its name, each dependency, its raw policy. */
export interface ManifestPart {
  /** Repo-relative path of the package.json. */
  manifest: string;
  /** Its `name`, or null when it has none. */
  name: string | null;
  deps: {
    section: (typeof SECTIONS)[number];
    name: string;
    raw: string;
  }[];
  /** The `dependencyPolicy` as written (parsed by the reader), when present. */
  policy?: { raw: unknown };
}

/** One manifest read: a JSON or schema error throws, naming nothing stored. */
export function manifestPartOf(src: string, rel: string): ManifestPart {
  const pkg = ManifestSchema.parse(JSON.parse(src));
  const deps: ManifestPart["deps"] = [];
  for (const section of SECTIONS)
    for (const [name, raw] of Object.entries(pkg[section] ?? {}))
      deps.push({ section, name, raw });
  const part: ManifestPart = { manifest: rel, name: pkg.name ?? null, deps };
  if (pkg[POLICY_KEY] !== undefined) part.policy = { raw: pkg[POLICY_KEY] };
  return part;
}

export const manifestsFold: FileFold<null, ManifestPart[]> = {
  url: import.meta.url,
  scan: (src, rel) => [manifestPartOf(src, rel)],
  combine: (parts) => parts.flat(),
};
