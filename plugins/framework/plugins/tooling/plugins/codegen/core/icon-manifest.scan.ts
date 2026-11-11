import { unresolvableCallIdMessage } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { isIconRefModule } from "@plugins/ui/plugins/icons/core";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import type TS from "typescript";

// The icon manifest's per-file scan (`icon-manifest-gen.ts`). A scan's records
// are keyed by its module's whole closure (`FileScan.url`), so this module
// holds the scan and the code it runs, and nothing else.

const MARKERS = { symbol: "symbols", brand: "brands", seti: "seti" } as const;
type Marker = keyof typeof MARKERS;

/**
 * Sound pre-filter: a file whose text never spells a constructor's name cannot
 * import one (an import names the export, aliased or not), so it is not parsed.
 */
const MARKER_NAME_RE = /\b(?:symbol|brand|seti)\b/;

const HINT =
  "The icon manifest lists every name a constructor is called with, so an icon " +
  "name must be a literal at the call site — a name the scan cannot read would " +
  "ship no sprite symbol and draw an empty box.";

export interface IconManifest {
  symbols: string[];
  brands: string[];
  seti: string[];
}

function isMarker(name: string): name is Marker {
  return Object.hasOwn(MARKERS, name);
}

/**
 * The icon names one file draws, read from its syntax tree — not its text.
 *
 * Every binding the file imports a constructor (`symbol` / `brand` / `seti`)
 * into, from the icons core by any spelling (`isIconRefModule`), is followed to
 * EVERY identifier naming it. Each must be the callee of a call whose one
 * argument is a string literal (what `icons/literal-icon-name` requires), and
 * its literal is collected — wherever the call sits (a spread, an argument, a
 * default). Any other use (passed around, re-exported, shadowed) throws: the
 * scan answers for every reference or refuses, so a name cannot be missed by
 * how its call is written.
 *
 * `displayPath` is repo-relative: relative imports resolve against it.
 */
export function scanIconNames(
  ts: typeof TS,
  src: string,
  displayPath: string,
): IconManifest {
  const out: IconManifest = { symbols: [], brands: [], seti: [] };
  if (!MARKER_NAME_RE.test(src)) return out;
  const sf = ts.createSourceFile(
    displayPath,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    displayPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (node: TS.Node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const fail = (node: TS.Node, what: string): never => {
    throw new Error(
      `${displayPath}:${lineOf(node)}: ${what} ${HINT} (icon manifest scan)`,
    );
  };

  // Local binding name → the constructor it is.
  const bindings = new Map<string, Marker>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!isIconRefModule(displayPath, stmt.moduleSpecifier.text)) continue;
    const clause = stmt.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const named = clause.namedBindings;
    if (named === undefined) continue;
    if (ts.isNamespaceImport(named)) {
      fail(
        named,
        "the icon constructors are imported through a namespace; import `symbol` / `brand` / `seti` by name.",
      );
      continue;
    }
    for (const el of named.elements) {
      if (el.isTypeOnly) continue;
      const imported = (el.propertyName ?? el.name).text;
      if (isMarker(imported)) bindings.set(el.name.text, imported);
    }
  }
  if (bindings.size === 0) return out;

  const visit = (node: TS.Node): void => {
    if (ts.isIdentifier(node)) {
      const marker = bindings.get(node.text);
      if (marker !== undefined) collect(node, marker);
    }
    ts.forEachChild(node, visit);
  };

  /** One identifier spelled like a bound constructor: a use to read, or a name that is not a reference. */
  const collect = (id: TS.Identifier, marker: Marker): void => {
    const parent = id.parent;
    // Spellings that are not a reference to the binding: the import itself, a
    // property or member name, an object-literal key, a label.
    if (ts.isImportSpecifier(parent)) return;
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return;
    if (ts.isQualifiedName(parent) && parent.right === id) return;
    if (
      (ts.isPropertyAssignment(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isEnumMember(parent) ||
        ts.isJsxAttribute(parent)) &&
      parent.name === id
    )
      return;
    if (ts.isBindingElement(parent) && parent.propertyName === id) return;
    if (
      (ts.isLabeledStatement(parent) ||
        ts.isBreakStatement(parent) ||
        ts.isContinueStatement(parent)) &&
      parent.label === id
    )
      return;
    // A declaration of the same name shadows the import: the scan would have to
    // guess which binding each later use means, so it refuses.
    if (
      (ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isBindingElement(parent)) &&
      parent.name === id
    )
      fail(
        id,
        `\`${id.text}\` is declared again, shadowing the imported icon constructor; rename it.`,
      );
    // Every other spelling is a use of the constructor: it must be called.
    if (
      !ts.isCallExpression(parent) ||
      parent.expression !== id ||
      parent.arguments.length !== 1
    )
      fail(
        id,
        `\`${id.text}\` is used other than called with one argument; call it directly with a string literal.`,
      );
    const call = parent as TS.CallExpression;
    const arg = call.arguments[0]!;
    if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg))
      throw new Error(
        unresolvableCallIdMessage({
          marker,
          file: displayPath,
          line: lineOf(call),
          expr: arg.getText(sf),
          hint: HINT,
        }),
      );
    out[MARKERS[marker]].push(arg.text);
  };

  visit(sf);
  return out;
}

/** The icon manifest's per-file scan, parsing with `ts`. */
export function iconManifestScan(ts: typeof TS): FileScan<IconManifest> {
  return {
    url: import.meta.url,
    scan: (src, rel) => scanIconNames(ts, src, rel),
  };
}
