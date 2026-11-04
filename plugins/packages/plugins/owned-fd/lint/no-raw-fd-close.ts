import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** Where owned descriptors come from. */
export const OWNED_FD_MODULE = "@plugins/packages/plugins/owned-fd/core";

const FS_MODULES = new Set(["fs", "node:fs"]);
const CLOSE_NAMES = new Set(["closeSync", "close"]);

function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier")
    return node.property.name;
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  )
    return node.property.value;
  return null;
}

/**
 * no-raw-fd-close
 *
 * A file descriptor is a bare number: closed twice, the second close lands on
 * whatever reused the number in between, and that resource dies silently
 * (2026-09-11: a pooled Postgres socket under a running query). Descriptors
 * are held as an `OwnedFd` (`packages/owned-fd`: `openOwnedFd`, `adoptFd`),
 * which closes exactly once and throws on a second close. Reported:
 *
 * - `closeSync` / `close` imported by name from `node:fs` (or `fs`);
 * - `fs.closeSync(…)` / `fs.close(…)` through a namespace or default import,
 *   or destructured out of one (`const { closeSync } = fs`).
 *
 * Not covered: `fs/promises`' `FileHandle#close` (already an owned handle),
 * `require("fs")`.
 */
export default createRule({
  name: "no-raw-fd-close",
  meta: {
    type: "problem",
    docs: {
      description:
        "File descriptors are closed through an OwnedFd (packages/owned-fd), never with fs.closeSync / fs.close on a bare number, so a double close throws at the culprit instead of silently closing whatever reused the number.",
    },
    schema: [],
    messages: {
      rawClose: `\`{{name}}\` closes a bare descriptor number: closed twice, it closes whatever reused the number in between (2026-09-11: a pooled Postgres socket mid-query). Hold the descriptor as an OwnedFd — \`openOwnedFd(…)\` / \`adoptFd(fd)\` from "${OWNED_FD_MODULE}" — and call its \`close()\`, which closes exactly once and throws on a second close.`,
    },
  },
  defaultOptions: [],
  create(context) {
    const source = context.sourceCode;
    const report = (node: TSESTree.Node, name: string) =>
      context.report({ node, messageId: "rawClose", data: { name } });
    return {
      ImportDeclaration(decl) {
        if (!FS_MODULES.has(decl.source.value) || decl.importKind === "type")
          return;
        for (const spec of decl.specifiers) {
          if (spec.type === "ImportSpecifier") {
            if (spec.importKind === "type") continue;
            const imported =
              spec.imported.type === "Identifier"
                ? spec.imported.name
                : spec.imported.value;
            if (CLOSE_NAMES.has(imported)) report(spec, imported);
            continue;
          }
          // `import * as fs` / `import fs`: its `.closeSync` / `.close` members.
          const variable = source.getDeclaredVariables(spec)[0];
          if (!variable) continue;
          for (const ref of (variable as TSESLint.Scope.Variable).references) {
            const parent = ref.identifier.parent;
            if (
              parent?.type === "VariableDeclarator" &&
              parent.init === ref.identifier &&
              parent.id.type === "ObjectPattern"
            ) {
              for (const p of parent.id.properties) {
                if (p.type !== "Property") continue;
                const key =
                  !p.computed && p.key.type === "Identifier"
                    ? p.key.name
                    : p.key.type === "Literal" &&
                        typeof p.key.value === "string"
                      ? p.key.value
                      : null;
                if (key !== null && CLOSE_NAMES.has(key)) report(p, key);
              }
              continue;
            }
            if (
              parent?.type !== "MemberExpression" ||
              parent.object !== ref.identifier
            )
              continue;
            const name = memberName(parent);
            if (name !== null && CLOSE_NAMES.has(name))
              report(parent, source.getText(parent));
          }
        }
      },
    };
  },
});
