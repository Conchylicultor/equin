import { readFile, writeFile } from "fs/promises";
import { join, relative } from "path";
import { packageNameFor } from "@plugins/framework/plugins/plugin-id/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";

/**
 * Plugin `package.json` `"name"` is DERIVED from the plugin's path
 * (`packageNameFor`), so no one types it and a moved plugin never carries a
 * stale one. This step writes it; the plugin-boundaries check (R1) is the
 * in-sync guard.
 *
 * Only the `"name"` value is touched — key order, indentation and every other
 * byte of the file are preserved, so the rewrite is a one-line diff. Idempotent:
 * a file whose name is already right is not written.
 *
 * Skipped, exactly as R1 skips them: composition roots (they self-declare via
 * `equin.compositionRoot` and carry their own names). A plugin with NO
 * `package.json` is left for R1 to report — creating one is an authoring act
 * (the file also carries the plugin's dependencies), not a derivation.
 *
 * Returns the repo-relative paths it rewrote, so a caller can re-resolve the
 * workspace: `bun.lock` records each member's name, and a renamed member makes
 * a frozen install fail until the lockfile is refreshed.
 */
export async function syncPluginPackageNames({
  root,
  tree,
}: {
  root: string;
  tree: PluginTree;
}): Promise<string[]> {
  const rewritten: string[] = [];
  for (const node of tree.byDir.values()) {
    if (node.compositionRoot) continue;
    const file = join(node.dir, "package.json");
    const text = await readIfExists(file);
    if (text === null) continue;
    const next = withPackageName(text, packageNameFor(node.path), file);
    if (next === text) continue;
    await writeFile(file, next);
    rewritten.push(relative(root, file));
  }
  return rewritten.sort();
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * `text` (a `package.json`) with its top-level `"name"` set to `name`, every
 * other byte unchanged. Returns `text` itself when the name is already right.
 * A missing `"name"` is inserted as the first key, indented like the key it
 * precedes.
 *
 * Throws on anything that is not a JSON object, and on a `"name"` whose value
 * is not a string — neither is a file this step can safely edit in place.
 * `file` only labels the error.
 */
export function withPackageName(
  text: string,
  name: string,
  file = "package.json",
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new Error(`${file}: not valid JSON (${err.message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON object`);
  }
  const current = (parsed as Record<string, unknown>).name;
  if (current === name) return text;

  const keys = topLevelKeys(text);
  const nameKeys = keys.filter((k) => k.key === "name");
  if (nameKeys.length > 0) {
    let out = text;
    // Back to front, so earlier offsets stay valid.
    for (const k of [...nameKeys].reverse()) {
      if (text[k.valueStart] !== '"') {
        throw new Error(
          `${file}: "name" is not a string — set it to "${name}" by hand`,
        );
      }
      const valueEnd = stringEnd(text, k.valueStart);
      out =
        out.slice(0, k.valueStart) + JSON.stringify(name) + out.slice(valueEnd);
    }
    return out;
  }

  const open = text.indexOf("{");
  const first = keys[0];
  const entry = `"name": ${JSON.stringify(name)}`;
  if (first === undefined) {
    // `{}` — no sibling to borrow indentation from.
    const close = text.lastIndexOf("}");
    return `${text.slice(0, open)}{\n  ${entry}\n}${text.slice(close + 1)}`;
  }
  const lead = text.slice(open + 1, first.keyStart);
  return `${text.slice(0, open + 1)}${lead}${entry},${text.slice(open + 1)}`;
}

interface KeySpan {
  key: string;
  /** Offset of the key's opening quote. */
  keyStart: number;
  /** Offset of the value's first character. */
  valueStart: number;
}

/** The top-level keys of a JSON object text, in source order, with offsets.
 *  Assumes `text` already parsed as JSON. */
function topLevelKeys(text: string): KeySpan[] {
  const keys: KeySpan[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      if (depth === 1) {
        let j = end;
        while (/\s/.test(text[j] ?? "")) j++;
        if (text[j] === ":") {
          j++;
          while (/\s/.test(text[j] ?? "")) j++;
          keys.push({
            key: JSON.parse(text.slice(i, end)) as string,
            keyStart: i,
            valueStart: j,
          });
        }
      }
      i = end;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return keys;
}

/** Offset just past the closing quote of the JSON string opening at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  throw new Error(`unterminated JSON string at offset ${start}`);
}
