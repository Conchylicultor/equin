// A web barrel's plugin definition, split from its re-exports.
//
// A web barrel is two things at once: the plugin's definition (its
// `export default { contributions, … }`) and the plugin's public API (its
// `export { X } from "./x"` list). The registry loads a plugin for the first
// (`web-sdk`'s `loadPlugins` reads `.default` and nothing else), but importing
// the barrel evaluates every module it re-exports — so registering a plugin
// loaded every helper and component it publishes for OTHER plugins, used or
// not (research/2026-11-14-global-load-redesign-r1-module-imports-route-chunks.md).
//
// The builder therefore emits the definition as its own module,
// `__plugin.js` ({@link PLUGIN_DEFINITION_ENTRY}): the barrel minus its
// re-exports — every import kept, side-effect imports included (21 barrels
// register descriptors that way), plus the default export. The barrel itself
// re-exports `default` from it, so there is ONE definition object whichever
// way it is reached. The link step points the registry's
// `import("@plugins/<p>/web")` at `__plugin.js`.
//
// Mechanical because barrels are pure (plugin-boundaries R3): only imports,
// re-exports, type declarations and one default export.

/** The emitted file's name (without `.js`) of a web barrel's definition. */
export const PLUGIN_DEFINITION_ENTRY = "__plugin";

export interface SplitBarrel {
  /** The barrel with its default export replaced by a re-export of the definition. */
  barrel: string;
  /** The barrel minus every re-export: its imports and its default export. */
  definition: string;
}

interface Node {
  type: string;
  start: number;
  end: number;
  source?: unknown;
  declaration?: unknown;
  exportKind?: string;
}

/**
 * Split a web barrel's source. `definitionSpecifier` is what the barrel's
 * `export { default } from …` names (the definition module's id).
 * Throws when the barrel has no default export (a web barrel must have one).
 */
export async function splitWebBarrel(opts: {
  source: string;
  filename: string;
  definitionSpecifier: string;
}): Promise<SplitBarrel> {
  // Lazy: the parser's native binding loads only when a web artifact builds.
  const { parseAst } = await import("rolldown/parseAst");
  const program = parseAst(opts.source, { lang: "ts" }, opts.filename) as {
    body: Node[];
  };
  let barrel = "";
  let definition = "";
  let at = 0;
  let sawDefault = false;
  for (const node of program.body) {
    const gap = opts.source.slice(at, node.start);
    const text = opts.source.slice(node.start, node.end);
    at = node.end;
    barrel += gap;
    definition += gap;
    if (node.type === "ExportDefaultDeclaration") {
      sawDefault = true;
      barrel += `export { default } from ${JSON.stringify(opts.definitionSpecifier)};`;
      definition += text;
      continue;
    }
    barrel += text;
    if (isReexport(node)) continue;
    definition += text;
  }
  const tail = opts.source.slice(at);
  barrel += tail;
  definition += tail;
  if (!sawDefault) {
    throw new Error(
      `${opts.filename}: a web barrel must export its plugin definition as \`export default\``,
    );
  }
  return { barrel, definition };
}

/**
 * A statement that only publishes names: `export { … } from "…"`,
 * `export * from "…"`, or an `export { a, b }` list of names the barrel
 * imported. `export type …` / `export interface …` are erased either way and
 * kept.
 */
function isReexport(node: Node): boolean {
  if (node.type === "ExportAllDeclaration") return node.exportKind !== "type";
  if (node.type !== "ExportNamedDeclaration") return false;
  if (node.exportKind === "type") return false;
  return node.source != null || node.declaration == null;
}
