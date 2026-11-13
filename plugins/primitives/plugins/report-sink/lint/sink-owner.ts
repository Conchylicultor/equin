import { relative } from "node:path";
import type { ParserServicesWithTypeInformation } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";
import {
  pluginIdOfRepoPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";

/** The plugin a file of this checkout lies in, from its absolute path (`null` outside `plugins/`). */
export function pluginOfFile(file: string): PluginId | null {
  const rel = relative(REPO_ROOT, file).split("\\").join("/");
  if (rel.startsWith("..")) return null;
  return pluginIdOfRepoPath(rel);
}

/**
 * The plugin declaring the value `expr` names — an imported binding followed
 * to its declaration — or `null` when it is not a plain reference to a
 * declaration inside `plugins/`.
 */
export function declaringPlugin(
  services: ParserServicesWithTypeInformation,
  expr: TSESTree.Node,
): PluginId | null {
  const checker = services.program.getTypeChecker();
  const tsNode = services.esTreeNodeToTSNodeMap.get(expr);
  let symbol = checker.getSymbolAtLocation(tsNode);
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias)
    symbol = checker.getAliasedSymbol(symbol);
  const decl = symbol.declarations?.[0];
  if (!decl) return null;
  return pluginOfFile(decl.getSourceFile().fileName);
}
