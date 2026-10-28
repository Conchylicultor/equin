import { createHash } from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import type { IconifyJSON } from "@iconify/types";

/**
 * The `SymbolName` / `BrandName` / `LucideName` unions, derived from the installed Iconify
 * JSON. Shared by the codegen step that writes the files (`./equin build` and
 * `regen-generated`, which the npm updater runs after every move — so an
 * icon-set upgrade regenerates its own names) and the
 * `icons:symbol-names-in-sync` check (which compares its inputs hash), so the
 * two cannot disagree about what the files are a function of.
 */

/** The Iconify packages the unions are a function of. */
export const ICON_SET_PACKAGES = [
  "@iconify-json/material-symbols",
  "@iconify-json/material-symbols-light",
  "@iconify-json/simple-icons",
  "@iconify-json/lucide",
] as const;

export const SYMBOL_NAMES_REL_PATH =
  "plugins/ui/plugins/icons/core/symbol-names.generated.ts";

/**
 * The same names as RUNTIME data, for the membership parse a saved (user-picked)
 * name goes through. A separate file in its own plugin (`saved-names`), so only
 * the plugins that validate a stored name ship it — the core barrel every
 * surface loads carries types only. JSON, not a `*.generated.ts` module.
 */
export const SYMBOL_NAME_LIST_REL_PATH =
  "plugins/ui/plugins/icons/plugins/saved-names/core/internal/symbol-names.json";

/** The shape of {@link SYMBOL_NAME_LIST_REL_PATH}. */
export interface SymbolNameList {
  /** The same stamp as the unions', checked by `icons:symbol-names-in-sync`. */
  inputsHash: string;
  from: string;
  /** Every SymbolName, space-separated. */
  names: string;
}

const HASH_RE = /\/\/ @inputs-hash ([a-f0-9]+)/;

function packageDir(pkg: string): string {
  return fileURLToPath(
    new URL(".", import.meta.resolve(`${pkg}/package.json`)),
  );
}

/** The installed version of each set: what the generated file is stamped with. */
export function installedSetVersions(): string[] {
  return ICON_SET_PACKAGES.map((pkg) => {
    const json = JSON.parse(
      readFileSync(`${packageDir(pkg)}package.json`, "utf8"),
    ) as { version: string };
    return `${pkg}@${json.version}`;
  });
}

// Bump when the derivation below changes, so the in-sync check asks for a
// regeneration even though no package moved.
const GENERATOR_VERSION = "3: lucide names";

export function symbolNamesInputsHash(versions: readonly string[]): string {
  return createHash("sha256")
    .update(GENERATOR_VERSION)
    .update(versions.join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/** The inputs hash a generated file was stamped with, or undefined when it has none. */
export function readInputsHash(generated: string): string | undefined {
  return HASH_RE.exec(generated)?.[1];
}

export function readIconSet(
  pkg: (typeof ICON_SET_PACKAGES)[number],
): IconifyJSON {
  return JSON.parse(
    readFileSync(`${packageDir(pkg)}icons.json`, "utf8"),
  ) as IconifyJSON;
}

const STYLE_SUFFIXES = [
  "-outline-rounded",
  "-outline-sharp",
  "-outline",
  "-rounded",
  "-sharp",
] as const;

/**
 * The base Material Symbols names: every name drawn in AT LEAST ONE of the 12
 * styles (3 shapes x 2 fills, regular and light). A missing style is drawn by
 * the nearest one that has the name (`resolveSymbolStyle` in core), so a name
 * need not exist everywhere to be offered.
 *
 * A key is reduced to its base by stripping a style suffix — but only when the
 * stripped name is itself a key. That keeps a glyph whose own name ends like a
 * suffix (`error-circle-rounded`, whose outline is
 * `error-circle-rounded-outline`) from inventing a base (`error-circle`) no set
 * draws. Deprecated (`hidden`) icons are included: they still draw, and the
 * classic names (`auto-awesome`, `insights`) are among them.
 */
export function symbolBaseNames(
  regular: IconifyJSON,
  light: IconifyJSON,
): string[] {
  const keys = new Set<string>();
  for (const set of [regular, light]) {
    for (const name of Object.keys(set.icons)) keys.add(name);
    for (const name of Object.keys(set.aliases ?? {})) keys.add(name);
  }
  const bases = new Set<string>();
  for (const name of keys) {
    const suffix = STYLE_SUFFIXES.find((s) => name.endsWith(s));
    const stripped =
      suffix === undefined ? name : name.slice(0, -suffix.length);
    bases.add(keys.has(stripped) ? stripped : name);
  }
  return [...bases].sort();
}

export function brandNames(brands: IconifyJSON): string[] {
  return Object.entries(brands.icons)
    .filter(([, icon]) => icon.hidden !== true)
    .map(([name]) => name)
    .sort();
}

/**
 * Every Lucide name a Material symbol may be mapped to (`core/lucide-map.ts`):
 * the visible icons plus every alias (Lucide keeps its renamed names as
 * aliases, so `home` and `house` both draw).
 */
export function lucideNames(lucide: IconifyJSON): string[] {
  const names = new Set<string>();
  for (const [name, icon] of Object.entries(lucide.icons)) {
    if (icon.hidden !== true) names.add(name);
  }
  for (const name of Object.keys(lucide.aliases ?? {})) names.add(name);
  return [...names].sort();
}

function union(names: readonly string[]): string {
  return names.map((n) => `  | ${JSON.stringify(n)}`).join("\n");
}

export function renderSymbolNames(inputs: {
  versions: readonly string[];
  symbols: readonly string[];
  brands: readonly string[];
  lucide: readonly string[];
}): string {
  return [
    "// AUTO-GENERATED by `./equin build` (plugins/ui/plugins/icons/plugins/icon-sets) — do not edit.",
    `// @inputs-hash ${symbolNamesInputsHash(inputs.versions)}`,
    `// From: ${inputs.versions.join(", ")}`,
    "//",
    "// SymbolName: every base Material Symbols name drawn in at least one of the",
    "// 12 styles (3 shapes x 2 fills x regular/light); a missing style draws the",
    "// nearest one that has it. BrandName: every visible Simple Icons slug.",
    "// LucideName: every visible Lucide icon or alias (a Material name's Lucide",
    "// counterpart, core/lucide-map.ts). The `icons:symbol-names-in-sync` check",
    "// fails when an installed set's version or this generator no longer matches.",
    "",
    `export type SymbolName =\n${union(inputs.symbols)};`,
    "",
    `export type BrandName =\n${union(inputs.brands)};`,
    "",
    `export type LucideName =\n${union(inputs.lucide)};`,
    "",
  ].join("\n");
}

export function renderSymbolNameList(inputs: {
  versions: readonly string[];
  symbols: readonly string[];
}): string {
  const list: SymbolNameList = {
    inputsHash: symbolNamesInputsHash(inputs.versions),
    from: inputs.versions.join(", "),
    names: inputs.symbols.join(" "),
  };
  return `${JSON.stringify(list, null, 2)}\n`;
}

/** The inputs hash a generated name list was stamped with, or undefined when it has none. */
export function readListInputsHash(json: string): string | undefined {
  const parsed = JSON.parse(json) as Partial<SymbolNameList>;
  return typeof parsed.inputsHash === "string" ? parsed.inputsHash : undefined;
}

/**
 * Both files derived from the installed sets — the unions
 * ({@link SYMBOL_NAMES_REL_PATH}) and the runtime name list
 * ({@link SYMBOL_NAME_LIST_REL_PATH}) — as repo-relative path + content, for
 * the codegen step to write. Reads every set (~0.5 s).
 */
export function renderSymbolNameFiles(): { path: string; content: string }[] {
  const versions = installedSetVersions();
  const symbols = symbolBaseNames(
    readIconSet("@iconify-json/material-symbols"),
    readIconSet("@iconify-json/material-symbols-light"),
  );
  return [
    {
      path: SYMBOL_NAMES_REL_PATH,
      content: renderSymbolNames({
        versions,
        symbols,
        brands: brandNames(readIconSet("@iconify-json/simple-icons")),
        lucide: lucideNames(readIconSet("@iconify-json/lucide")),
      }),
    },
    {
      path: SYMBOL_NAME_LIST_REL_PATH,
      content: renderSymbolNameList({ versions, symbols }),
    },
  ];
}
