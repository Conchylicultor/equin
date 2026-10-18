import type { ServerRegistryEntry } from "../boot-stages";

/**
 * The registry entry of `pluginPath`'s server barrel, as codegen writes one
 * (`<id>` the dotted path, loaded by its `@plugins/<path>/server` specifier),
 * with the `dependsOn` the caller states.
 */
export function serverEntryFor(
  pluginPath: string,
  dependsOn: string[],
): ServerRegistryEntry {
  return {
    pluginPath,
    id: pluginPath.split("/plugins/").join("."),
    loader: () => import(`@plugins/${pluginPath}/server`),
    dependsOn,
  };
}
