import {
  RUNTIME_FOLDERS,
  asPath,
} from "@plugins/framework/plugins/plugin-id/core";
import type { CrossRefsData } from "./types";

// Diff projection: the deduped union of apiUses across all runtimes, plus each
// token var read from another plugin's group. importedBy is a
// derived reverse index (depends on OTHER plugins), so it is intentionally excluded.
export function crossRefsToComparable(data: CrossRefsData): string[] {
  const uses = new Set<string>();
  for (const rt of RUNTIME_FOLDERS)
    for (const u of data.apiUses[rt])
      uses.add(`${asPath(u.plugin)}${u.symbol ? "." + u.symbol : ""}`);
  for (const u of data.tokenUses)
    for (const v of u.vars) uses.add(`${asPath(u.plugin)} ${v}`);
  return [...uses];
}
