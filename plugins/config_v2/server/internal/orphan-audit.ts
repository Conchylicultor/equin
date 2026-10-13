import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { configFileOwner, APP_SCOPE_DIR } from "@plugins/config_v2/core";
import type {
  ConfigDescriptor,
  OrphanEntry,
  OrphanFile,
  OrphanFileRole,
  OrphanReport,
} from "@plugins/config_v2/core";
import { CONFIG_DIR } from "./config-dir";
import { getAllDescriptors } from "./resource";

// A file is scoped when it sits under an `@app/<id>/` segment:
// `<hier>/@app/<id>/<name>.<ext>`.
function isScoped(relPath: string): boolean {
  return new RegExp(`(^|/)${APP_SCOPE_DIR}/[^/]+/[^/]+$`).test(relPath);
}

// Role of an on-disk file, from its `.jsonc` suffix (longest first) and scope.
// A scoped ancestor is never written (propagate captures ancestors for the base
// layer only), so ancestor has no scoped variant.
function fileRole(relPath: string): OrphanFileRole {
  const scoped = isScoped(relPath);
  if (relPath.endsWith(".origin.jsonc"))
    return scoped ? "scoped-origin" : "origin";
  if (relPath.endsWith(".ancestor.jsonc")) return "ancestor";
  return scoped ? "scoped-override" : "override";
}

// Recursively collect every `.jsonc` file under `dir`, returning paths relative to
// `baseDir` (forward-slash separated). Kept local so the server never imports
// codegen's build-time `walkJsoncFiles` (no server → build-tooling edge).
// Async: its reader is a live-value loader re-run on every config write, which
// must never block the event loop for a walk of the whole config dir.
async function walkJsoncFiles(
  dir: string,
  baseDir: string,
  out: string[],
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsoncFiles(full, baseDir, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonc"))
      out.push(
        full
          .slice(baseDir.length + 1)
          .split("\\")
          .join("/"),
      );
  }
}

// A user-layer config dir not created yet holds nothing, so nothing orphaned.
async function dirExists(dir: string): Promise<boolean> {
  try {
    await stat(dir);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Read-only audit of the USER-layer config dir (`~/.singularity/state/config/<worktree>`):
 * every on-disk config file whose owning `defineConfig` descriptor is no longer
 * live is an orphan. Unlike the git layer (`pruneOrphanedConfigFiles`), user-layer
 * files are unversioned so we never delete — we classify:
 *
 *   - riskClass: `stranded-data` if any file is a base/scoped OVERRIDE (real user
 *     data that silently stopped applying), else `noise` (origin/ancestor only).
 *   - reason: `relocated` (with `relocatedToHier`) when EXACTLY ONE live descriptor
 *     shares this name at a different hierarchy — an unambiguous move target. A name
 *     borne by many live descriptors (e.g. the default "config") can't be pinpointed,
 *     so it is reported as `removed`. Still a hint, not proof; else `removed`.
 *
 * `configDir` and `descriptors` are parameters (defaulting to the real
 * `CONFIG_DIR` + live registry) so the audit is unit-testable against a temp dir
 * and a fake live set without touching env or the registry.
 */
export async function auditUserConfigOrphans(
  configDir: string = CONFIG_DIR,
  descriptors: [string, ConfigDescriptor][] = getAllDescriptors(),
): Promise<OrphanReport> {
  if (!(await dirExists(configDir))) return { orphans: [] };

  // Live descriptors grouped by hierarchy → the names that keep files alive, plus
  // a name → hierarchies index for the relocated heuristic.
  const liveByHier = new Map<string, Set<string>>();
  const hiersByName = new Map<string, Set<string>>();
  for (const [storePath] of descriptors) {
    const owner = configFileOwner(storePath);
    if (!owner) continue;
    let names = liveByHier.get(owner.hier);
    if (!names) liveByHier.set(owner.hier, (names = new Set()));
    names.add(owner.name);
    let hiers = hiersByName.get(owner.name);
    if (!hiers) hiersByName.set(owner.name, (hiers = new Set()));
    hiers.add(owner.hier);
  }

  const onDisk: string[] = [];
  await walkJsoncFiles(configDir, configDir, onDisk);

  // Group orphaned files by their base descriptor key.
  const groups = new Map<
    string,
    { hier: string; name: string; files: OrphanFile[] }
  >();
  for (const relPath of onDisk) {
    const owner = configFileOwner(relPath);
    if (!owner) continue;
    if (liveByHier.get(owner.hier)?.has(owner.name)) continue; // live — not an orphan

    const storeKey = `${owner.hier}/${owner.name}`;
    let group = groups.get(storeKey);
    if (!group)
      groups.set(
        storeKey,
        (group = { hier: owner.hier, name: owner.name, files: [] }),
      );

    const st = await stat(join(configDir, relPath));
    group.files.push({
      relPath,
      role: fileRole(relPath),
      bytes: st.size,
      mtimeMs: st.mtimeMs,
    });
  }

  const orphans: OrphanEntry[] = [];
  for (const [storeKey, group] of groups) {
    // Any real override document (base or scoped) means user data is stranded.
    const riskClass = group.files.some(
      (f) => f.role === "override" || f.role === "scoped-override",
    )
      ? "stranded-data"
      : "noise";

    // A live descriptor of the same name at a DIFFERENT hierarchy ⇒ likely moved.
    // Only an UNAMBIGUOUS single match is a credible target: a name shared by many
    // live descriptors (e.g. the default "config") can't be pinpointed to one
    // destination, so we report those as `removed` rather than assert a wrong hier.
    const otherHiers = [...(hiersByName.get(group.name) ?? [])].filter(
      (h) => h !== group.hier,
    );
    const relocatedToHier = otherHiers.length === 1 ? otherHiers[0] : undefined;

    orphans.push({
      storeKey,
      hier: group.hier,
      name: group.name,
      riskClass,
      reason: relocatedToHier !== undefined ? "relocated" : "removed",
      ...(relocatedToHier !== undefined ? { relocatedToHier } : {}),
      files: group.files,
      totalBytes: group.files.reduce((sum, f) => sum + f.bytes, 0),
      newestMtimeMs: group.files.reduce(
        (max, f) => Math.max(max, f.mtimeMs),
        0,
      ),
    });
  }

  // Deterministic: data-bearing orphans first, then by storeKey.
  orphans.sort((a, b) => {
    if (a.riskClass !== b.riskClass)
      return a.riskClass === "stranded-data" ? -1 : 1;
    return a.storeKey < b.storeKey ? -1 : a.storeKey > b.storeKey ? 1 : 0;
  });

  return { orphans };
}
