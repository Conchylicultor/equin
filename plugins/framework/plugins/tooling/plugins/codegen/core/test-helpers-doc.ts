import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { join, dirname } from "path";
import {
  RUNTIME_FOLDERS,
  TESTING_FOLDER,
  type RuntimeFolder,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  findImports,
  maskSource,
  parseBarrelExports,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { readIfExistsSync } from "@plugins/plugin-meta/plugins/parse-utils/plugins/source-files/core";

/**
 * A plugin's shared test helpers: what each `<runtime>/testing/index.ts` barrel
 * exports, rendered as the `Test helpers` item of the plugin's doc entry.
 *
 * Deliberately NOT a facet. Facets feed every generic plugin surface (docgen,
 * Studio's plugin detail, contributions, the PR diff) as the plugin's API, and
 * `doc-facts-guard` refuses test code in all of their output. A testing barrel is
 * not API, but an agent writing a test must be able to find it before writing
 * its own fixture — so docgen renders it here, under its own label, and this is
 * the one place the generated docs spell a `…/testing` specifier.
 */

export interface TestHelperSymbol {
  name: string;
  /** First sentence of the declaration's JSDoc, when it has one. */
  summary?: string;
}

export interface TestHelperBarrel {
  runtime: RuntimeFolder;
  specifier: string;
  values: TestHelperSymbol[];
  types: string[];
}

/** The plugin's testing barrels, in runtime order; empty when it publishes none. */
export function collectTestHelpers(p: {
  dir: AppPath;
  path: string;
}): TestHelperBarrel[] {
  const out: TestHelperBarrel[] = [];
  for (const runtime of RUNTIME_FOLDERS) {
    const barrelFile = joinAppPath(p.dir, runtime, TESTING_FOLDER, "index.ts");
    const raw = readIfExistsSync(barrelFile);
    if (raw === null) continue;
    const masked = maskSource(raw);
    const sources = reExportSources(raw, asAppPath(dirname(barrelFile)));
    const symbols = parseBarrelExports(masked);
    out.push({
      runtime,
      specifier: `@plugins/${p.path}/${runtime}/${TESTING_FOLDER}`,
      values: symbols
        .filter((s) => s.kind === "value")
        .map(({ name }) => {
          const file = sources.get(name) ?? barrelFile;
          const summary = declarationSummary(
            readIfExistsSync(file) ?? "",
            name,
          );
          return summary === undefined ? { name } : { name, summary };
        }),
      types: symbols.filter((s) => s.kind === "type").map((s) => s.name),
    });
  }
  return out;
}

/** The `Test helpers` item's lines, or none when the plugin has no testing barrel. */
export function renderTestHelpers(
  barrels: readonly TestHelperBarrel[],
  bodyIndent: string,
): string[] {
  if (barrels.length === 0) return [];
  const rtIndent = `${bodyIndent}  `;
  const symIndent = `${rtIndent}  `;
  const lines = [`${bodyIndent}- Test helpers:`];
  for (const b of barrels) {
    lines.push(
      `${rtIndent}- ${b.runtime.charAt(0).toUpperCase()}${b.runtime.slice(1)}: \`${b.specifier}\``,
    );
    for (const v of b.values) {
      lines.push(
        `${symIndent}- \`${v.name}\`${v.summary ? ` — ${v.summary}` : ""}`,
      );
    }
    if (b.types.length > 0) {
      lines.push(
        `${symIndent}- Types: ${b.types.map((t) => `\`${t}\``).join(", ")}`,
      );
    }
  }
  return lines;
}

/**
 * Exported name → the file its `export { … } from "./x"` re-exports it from,
 * read through parse-utils' shared import scanner.
 */
function reExportSources(raw: string, fromDir: AppPath): Map<string, AppPath> {
  const out = new Map<string, AppPath>();
  for (const ref of findImports(raw)) {
    if (ref.keyword !== "export" || !ref.specifier.startsWith(".")) continue;
    const braces = /\{([^}]*)\}/.exec(ref.clause);
    if (!braces) continue;
    const file = resolveModule(asAppPath(join(fromDir, ref.specifier)));
    if (file === undefined) continue;
    for (const item of braces[1]!.split(",")) {
      const s = item.trim().replace(/^type\s+/, "");
      if (!s) continue;
      const as = /^(\w+)\s+as\s+(\w+)$/.exec(s);
      out.set(as ? as[2]! : s, file);
    }
  }
  return out;
}

function resolveModule(base: AppPath): AppPath | undefined {
  for (const c of [
    asAppPath(`${base}.ts`),
    asAppPath(`${base}.tsx`),
    joinAppPath(base, "index.ts"),
    joinAppPath(base, "index.tsx"),
  ]) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/**
 * The first sentence of the JSDoc directly above `name`'s exported declaration
 * in `src`, or undefined when it has none.
 */
export function declarationSummary(
  src: string,
  name: string,
): string | undefined {
  const masked = maskSource(src);
  const decl = new RegExp(
    `export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let|var|enum)\\s+${name}\\b`,
  ).exec(masked);
  if (!decl) return undefined;
  const before = src.slice(0, decl.index).trimEnd();
  if (!before.endsWith("*/")) return undefined;
  const open = before.lastIndexOf("/**");
  if (open < 0) return undefined;
  const body = before
    .slice(open + 3, -2)
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, "").trimEnd());
  const paragraph: string[] = [];
  for (const l of body) {
    if (l.startsWith("@")) break;
    if (l === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(l.trim());
  }
  const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  // A sentence ends at a stop followed by a capital (or the end), so an
  // abbreviation like "e.g. `x`" does not cut it short.
  const end = /[.!?](?=\s+[A-Z]|$)/.exec(text);
  return end ? text.slice(0, end.index + 1) : text;
}
