import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import ts from "typescript";

// The registry generator's per-file scans (`plugin-registry-gen.ts`, and the
// fields eager manifest's barrel test). A scan's records are keyed by its
// module's whole closure (`FileScan.url`), so this module holds the scans and
// the code they run, and nothing else.
//
// Both read the file's SYNTAX TREE, never its text. A barrel the registry
// misses is a plugin that silently never loads, and the registry's in-sync
// check compares against a re-run of these same scans — so they must not be
// able to misread a spelling. The text masker they used to run once lost sync
// on a nested template literal and read server-core's `export default` as
// string, dropping its check from the registry with nothing failing.

function parse(src: string, rel: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Does the module export a default: `export default …`, an
 * `export default function/class`, or `export { x as default }` (re-exported
 * or local)? A type-only `export type { X as default }` exports no value.
 */
export function hasDefaultExport(src: string, rel: string): boolean {
  for (const stmt of parse(src, rel).statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) return true;
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      stmt.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    )
      return true;
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      stmt.exportClause !== undefined &&
      ts.isNamedExports(stmt.exportClause) &&
      stmt.exportClause.elements.some(
        (el) => !el.isTypeOnly && el.name.text === "default",
      )
    )
      return true;
  }
  return false;
}

/**
 * Every module specifier the file's static import and export-from statements
 * name (type-only ones included: they order the dependency graph the same
 * way), and `import x = require("…")`; inside an ambient `declare module`
 * block too. Dynamic `import()` is not a static edge and is not read.
 */
export function importSpecifiers(src: string, rel: string): string[] {
  const out: string[] = [];
  const visit = (statements: readonly ts.Statement[]): void => {
    for (const stmt of statements) {
      if (
        (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
        stmt.moduleSpecifier !== undefined &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        out.push(stmt.moduleSpecifier.text);
      } else if (
        ts.isImportEqualsDeclaration(stmt) &&
        ts.isExternalModuleReference(stmt.moduleReference) &&
        ts.isStringLiteral(stmt.moduleReference.expression)
      ) {
        out.push(stmt.moduleReference.expression.text);
      } else if (
        ts.isModuleDeclaration(stmt) &&
        stmt.body !== undefined &&
        ts.isModuleBlock(stmt.body)
      ) {
        visit(stmt.body.statements);
      }
    }
  };
  visit(parse(src, rel).statements);
  return out;
}

export const DEFAULT_EXPORT_SCAN: FileScan<boolean> = {
  url: import.meta.url,
  params: ["default-export"],
  scan: (src, rel) => hasDefaultExport(src, rel),
};
export const IMPORT_SPECIFIER_SCAN: FileScan<string[]> = {
  url: import.meta.url,
  params: ["import-specifiers"],
  scan: (src, rel) => importSpecifiers(src, rel),
};
