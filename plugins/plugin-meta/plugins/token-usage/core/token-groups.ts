import ts from "typescript";
import { tokenVarName } from "@plugins/ui/plugins/theme-engine/core";

/** One token group a source file declares: its id and the CSS vars it supplies. */
export interface DeclaredTokenGroup {
  id: string;
  vars: string[];
}

// `e` without the type-only wrappers (`satisfies`, `as`, parentheses) that
// leave its value unchanged.
function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isSatisfiesExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isParenthesizedExpression(e)
  )
    e = e.expression;
  return e;
}

// The object literal a schema argument spells: written inline, or held in a
// `const` of the same file. `null` for anything else (a call, an import, a
// spread) — the caller throws.
function schemaLiteral(
  arg: ts.Expression,
  sf: ts.SourceFile,
): ts.ObjectLiteralExpression | null {
  const e = unwrap(arg);
  if (ts.isObjectLiteralExpression(e)) return e;
  if (!ts.isIdentifier(e)) return null;
  for (const stmt of sf.statements) {
    if (
      !ts.isVariableStatement(stmt) ||
      !(stmt.declarationList.flags & ts.NodeFlags.Const)
    )
      continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== e.text) continue;
      const init = decl.initializer && unwrap(decl.initializer);
      return init && ts.isObjectLiteralExpression(init) ? init : null;
    }
  }
  return null;
}

/**
 * The token groups `source` declares with `defineTokenGroup("<id>", { … })`,
 * read statically: the id is the first argument's string literal and each var
 * is `tokenVarName(key)` of the schema's own keys (an inline object literal, or
 * one held in a same-file `const`) — the rule `defineTokenGroup`
 * applies at runtime.
 *
 * Static because its reader (the cross-refs facet) runs over source files only,
 * before any barrel can be imported. A call whose id or schema is not a literal
 * THROWS: an unreadable group would otherwise silently drop the edges of every
 * plugin using its tokens. The `token-group-vars-in-sync` check holds this
 * reading equal to the imported descriptors.
 */
export function tokenGroupsDeclaredIn(
  source: string,
  file: string,
): DeclaredTokenGroup[] {
  if (!source.includes("defineTokenGroup")) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const groups: DeclaredTokenGroup[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineTokenGroup"
    ) {
      const [idArg, schemaArg] = node.arguments;
      const where = `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
      if (!idArg || !ts.isStringLiteralLike(idArg))
        throw new Error(
          `${where}: defineTokenGroup's id must be a string literal, so the token's owner can be read statically.`,
        );
      const schema = schemaArg && schemaLiteral(schemaArg, sf);
      if (!schema)
        throw new Error(
          `${where}: defineTokenGroup("${idArg.text}")'s schema must be an object literal (inline, or a const declared in the same file), so its CSS vars can be read statically.`,
        );
      const vars: string[] = [];
      for (const prop of schema.properties) {
        const name =
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))
            ? prop.name.text
            : null;
        if (name === null)
          throw new Error(
            `${where}: defineTokenGroup("${idArg.text}")'s schema has a key that is not a plain or quoted name (spread, computed or shorthand) — its CSS var cannot be read statically.`,
          );
        vars.push(tokenVarName(name));
      }
      groups.push({ id: idArg.text, vars: vars.sort() });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return groups;
}
