/**
 * A key as seen from a plugin scope. The page (scope `null`) keeps the bare
 * key; a `<PluginScope>` (the demo's embedded app — another equin, on its own
 * server) prefixes its id, so an anchor it registers, a tip it asks for and a
 * tip it answered never meet the page's own under the same name.
 */
export function inScope(scope: string | null, key: string): string {
  return scope === null ? key : `${scope}\u0000${key}`;
}
