import { isIconRefModule } from "./icon-module";

/**
 * Every use of the icon constructors (`symbol` / `brand` / `seti`) in one
 * module, read through ESLint's SCOPE ANALYSIS: each import of a constructor
 * from the icons core (by any spelling, `isIconRefModule`) is followed to the
 * references its declared variable has — the binding, not the spelling.
 *
 * The one reader of icon uses for the icons lint rules
 * (`icons/literal-icon-name`, `icons/reserved-state-icon`,
 * `icons/reserved-nav-icon`) and for `icons:manifest-covers-uses`, which
 * checks the generated icon manifest against it. That check exists because a
 * check comparing the manifest to a re-run of its own generator cannot catch a
 * generator bug (a spread `...symbol("x")` once dropped a name from both
 * sides): this is a second, independent reading — ESLint's scope manager, not
 * the generator's TypeScript name walk.
 *
 * Typed structurally (the ESTree subset it reads) so the icons core, shared
 * with the browser, depends on no linter package: an ESLint `Program` and its
 * `getDeclaredVariables` (a rule's `context.sourceCode`, or a
 * `@typescript-eslint/parser` scope manager) both fit.
 */

export type IconMarker = "symbol" | "brand" | "seti";

const MARKERS: ReadonlySet<string> = new Set<IconMarker>([
  "symbol",
  "brand",
  "seti",
]);

/** The ESTree node shape this reader needs: a type and a parent. */
export interface EsNode {
  type: string;
  parent?: EsNode | null;
  range?: readonly [number, number];
  loc?: { start: { line: number } } | null;
}

interface EsIdentifier extends EsNode {
  name: string;
}

interface EsImportSpecifier extends EsNode {
  type: "ImportSpecifier";
  imported: EsNode & { name?: string; value?: unknown };
  local: EsIdentifier;
  importKind?: "type" | "value";
}

interface EsImportDeclaration extends EsNode {
  type: "ImportDeclaration";
  source: { value: unknown };
  importKind?: "type" | "value";
  specifiers: readonly EsNode[];
}

interface EsCall extends EsNode {
  type: "CallExpression";
  callee: EsNode;
  arguments: readonly (EsNode & { value?: unknown })[];
}

export interface EsProgram extends EsNode {
  body: readonly EsNode[];
}

/** One variable a declaration declares, and the identifiers referencing it. */
export interface DeclaredVariable {
  name: string;
  references: readonly { identifier: EsNode }[];
}

/** A scope manager's answer for one declaration: its variables and their references. */
export type DeclaredVariables = (node: never) => readonly DeclaredVariable[];

/** A constructor called with one string literal: an icon name the code draws. */
export interface IconCall {
  marker: IconMarker;
  name: string;
  call: EsNode;
}

/**
 * A use the manifest cannot read a name from — what `icons/literal-icon-name`
 * reports: a namespace import, an aliased import, the constructor passed
 * around, or called without one string literal.
 */
export interface IconMisuse {
  kind: "namespace" | "aliased" | "notCalled" | "notLiteral";
  marker: IconMarker | undefined;
  node: EsNode;
}

export interface IconUses {
  calls: IconCall[];
  misuses: IconMisuse[];
}

function importedName(spec: EsImportSpecifier): string | undefined {
  const { imported } = spec;
  if (imported.type === "Identifier") return imported.name;
  return typeof imported.value === "string" ? imported.value : undefined;
}

/** Every icon-constructor use in `program` (`filename`: absolute or repo-relative). */
export function iconUsesIn(
  program: EsProgram,
  filename: string,
  getDeclaredVariables: DeclaredVariables,
): IconUses {
  const calls: IconCall[] = [];
  const misuses: IconMisuse[] = [];
  // The caller's scope manager takes its own node type; every node handed
  // back here came from its own tree.
  const declared = getDeclaredVariables as (
    node: EsNode,
  ) => readonly DeclaredVariable[];
  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const decl = stmt as EsImportDeclaration;
    if (decl.importKind === "type") continue;
    if (typeof decl.source.value !== "string") continue;
    if (!isIconRefModule(filename, decl.source.value)) continue;
    for (const s of decl.specifiers) {
      if (s.type === "ImportNamespaceSpecifier") {
        misuses.push({ kind: "namespace", marker: undefined, node: s });
        continue;
      }
      if (s.type !== "ImportSpecifier") continue;
      const spec = s as EsImportSpecifier;
      if (spec.importKind === "type") continue;
      const imported = importedName(spec);
      if (imported === undefined || !MARKERS.has(imported)) continue;
      const marker = imported as IconMarker;
      if (spec.local.name !== imported) {
        misuses.push({ kind: "aliased", marker, node: spec });
      }
      const variable = declared(spec).find(
        (v: DeclaredVariable) => v.name === spec.local.name,
      );
      for (const ref of variable?.references ?? []) {
        const id = ref.identifier;
        const parent = id.parent;
        if (
          parent?.type !== "CallExpression" ||
          (parent as EsCall).callee !== id
        ) {
          misuses.push({ kind: "notCalled", marker, node: id });
          continue;
        }
        const call = parent as EsCall;
        const [arg, ...rest] = call.arguments;
        if (
          arg === undefined ||
          rest.length > 0 ||
          arg.type !== "Literal" ||
          typeof arg.value !== "string"
        ) {
          misuses.push({ kind: "notLiteral", marker, node: call });
          continue;
        }
        calls.push({ marker, name: arg.value, call });
      }
    }
  }
  return { calls, misuses };
}
