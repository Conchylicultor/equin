import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import { guardEntries } from "./guard.generated";
import { GUARDS } from "./registry";
import type { Guard } from "./types";

function isGuard(v: unknown): v is Guard<unknown> {
  const g = v as Guard<unknown>;
  return (
    typeof g === "object" &&
    g !== null &&
    typeof g.name === "string" &&
    typeof g.check === "function" &&
    (typeof g.matcher === "string" || Array.isArray(g.matcher))
  );
}

/**
 * The built-in guards, then every plugin's `guard/index.ts` (default export: a
 * guard or an array). Strict: a guard that failed to load is indistinguishable
 * from one that let every call through, so the hook fails loudly instead.
 */
export async function loadGuards(): Promise<Guard<any>[]> {
  const contributed = await loadCollectedDir<Guard<unknown>>(guardEntries, {
    isItem: isGuard,
    strict: true,
  });
  return [...GUARDS, ...contributed];
}
