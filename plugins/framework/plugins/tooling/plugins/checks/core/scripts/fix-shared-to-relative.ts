#!/usr/bin/env bun
/**
 * Rewrite `@plugins/<name>/shared` alias imports to relative `../shared` paths,
 * then remove `shared/index.ts` barrel files that are no longer imported.
 *
 * Usage:
 *   ./equin run plugins/framework/plugins/tooling/plugins/checks/core/scripts/fix-shared-to-relative.ts           # apply fixes
 *   ./equin run plugins/framework/plugins/tooling/plugins/checks/core/scripts/fix-shared-to-relative.ts --dry-run # preview only
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, relative, sep } from "path";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

const SOURCE_ROOTS = ["plugins", "plugins/framework/plugins/web-core/web"];
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git"]);

function walkTs(dir: string, out: string[]) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      walkTs(join(dir, e.name), out);
    } else if (
      e.isFile() &&
      (e.name.endsWith(".ts") || e.name.endsWith(".tsx"))
    ) {
      out.push(join(dir, e.name));
    }
  }
}

function pluginForPath(relFile: string, pluginSet: Set<string>): string | null {
  const norm = relFile.split(sep).join("/");
  if (!norm.startsWith("plugins/")) return null;
  const rest = norm.slice("plugins/".length);
  const parts = rest.split("/");
  let best: string | null = null;
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join("/");
    if (pluginSet.has(candidate)) best = candidate;
  }
  return best;
}

const dryRun = process.argv.includes("--dry-run");
const root = await getWorktreeRoot();
const pluginsRoot = join(root, "plugins");
const tree = await buildStructureTreeOnce(pluginsRoot);
const pluginSet = new Set(Array.from(tree.byDir.values()).map((n) => n.path));

const files: string[] = [];
for (const r of SOURCE_ROOTS) {
  const abs = join(root, r);
  if (existsSync(abs)) walkTs(abs, files);
}

// Regex to match `@plugins/<plugin-path>/shared` imports (with or without deep path)
const aliasRe = /from\s+["'](@plugins\/[^"']+\/shared(?:\/[^"']*)?)["']/g;

let totalFixes = 0;
let totalFiles = 0;

for (const absFile of files) {
  const relFile = relative(root, absFile).split(sep).join("/");
  const sourcePlugin = pluginForPath(relFile, pluginSet);
  if (!sourcePlugin) continue;

  const src = readFileSync(absFile, "utf-8");
  const replacements: Array<{ from: string; to: string }> = [];

  for (const m of src.matchAll(aliasRe)) {
    const fullPath = m[1]!;
    // Extract the plugin path from @plugins/<plugin-path>/shared[/...]
    const afterPlugins = fullPath.slice("@plugins/".length);

    // Find the plugin this import targets
    const parts = afterPlugins.split("/");
    let targetPlugin = "";
    for (let i = 1; i <= parts.length; i++) {
      const candidate = parts.slice(0, i).join("/");
      if (pluginSet.has(candidate)) targetPlugin = candidate;
    }
    if (!targetPlugin) continue;

    // Only rewrite intra-plugin imports
    if (targetPlugin !== sourcePlugin) continue;

    // Compute the suffix after shared (e.g. "/types" or "")
    const sharedIdx = afterPlugins.indexOf("/shared");
    const afterShared = afterPlugins.slice(sharedIdx + "/shared".length); // "" or "/types"

    // Compute relative path from source file to plugin's shared/ directory
    const pluginSharedDir = join(root, "plugins", sourcePlugin, "shared");
    const sourceDir = dirname(absFile);
    let relPath = relative(sourceDir, pluginSharedDir).split(sep).join("/");
    if (!relPath.startsWith(".")) relPath = "./" + relPath;

    const newImport = relPath + afterShared;
    replacements.push({ from: fullPath, to: newImport });
  }

  if (replacements.length === 0) continue;

  let newSrc = src;
  for (const { from, to } of replacements) {
    newSrc = newSrc
      .replaceAll(`"${from}"`, `"${to}"`)
      .replaceAll(`'${from}'`, `'${to}'`);
    console.log(`  ${relFile}: "${from}" → "${to}"`);
    totalFixes++;
  }

  totalFiles++;
  if (!dryRun) writeFileSync(absFile, newSrc, "utf-8");
}

const prefix = dryRun ? "[dry-run] " : "";
console.log(
  `\n${prefix}${totalFixes} import(s) rewritten in ${totalFiles} file(s).`,
);

// --- Phase 2: Remove unused shared/index.ts barrels ---

// Collect all shared/index.ts files
const barrels: string[] = [];
for (const pluginPath of pluginSet) {
  const barrel = join(root, "plugins", pluginPath, "shared", "index.ts");
  if (existsSync(barrel)) barrels.push(barrel);
}

// Re-read all source files to check if any barrel is still referenced
const allSources: string[] = [];
for (const r of SOURCE_ROOTS) {
  const abs = join(root, r);
  if (existsSync(abs)) walkTs(abs, allSources);
}

const deletedFiles = new Set<string>();
let removedBarrels = 0;
for (const barrel of barrels) {
  const barrelDir = dirname(barrel);
  const barrelRel = relative(root, barrelDir).split(sep).join("/");
  const pluginPath = barrelRel
    .replace(/^plugins\//, "")
    .replace(/\/shared$/, "");

  // Check if any file imports this barrel (either alias or relative resolving to shared/index)
  let isUsed = false;
  for (const srcFile of allSources) {
    if (srcFile === barrel || deletedFiles.has(srcFile)) continue;
    let content: string;
    try {
      content = readFileSync(srcFile, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue;
    }
    // Check alias barrel import: @plugins/<plugin>/shared" (not @plugins/<plugin>/shared/)
    const aliasBarrel = `@plugins/${pluginPath}/shared`;
    const aliasBarrelPattern = new RegExp(
      `from\\s+["']${aliasBarrel.replace(/\//g, "\\/")}["']`,
    );
    if (aliasBarrelPattern.test(content)) {
      isUsed = true;
      break;
    }
    // Check relative barrel import: from "../shared" or from "../../shared" etc.
    // We look for imports ending with /shared" that resolve to this barrel's directory
    const relFromSrc = relative(dirname(srcFile), barrelDir)
      .split(sep)
      .join("/");
    const relPattern = relFromSrc.startsWith(".")
      ? relFromSrc
      : "./" + relFromSrc;
    if (
      content.includes(`"${relPattern}"`) ||
      content.includes(`'${relPattern}'`)
    ) {
      isUsed = true;
      break;
    }
  }

  if (!isUsed) {
    console.log(`  removing unused barrel: ${relative(root, barrel)}`);
    if (!dryRun) {
      unlinkSync(barrel);
      deletedFiles.add(barrel);
    }
    removedBarrels++;
  }
}

console.log(
  `${prefix}${removedBarrels} unused shared/index.ts barrel(s) removed.`,
);
