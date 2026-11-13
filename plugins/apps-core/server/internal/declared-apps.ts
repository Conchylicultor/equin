import { composedOnly } from "@plugins/framework/plugins/server-core/core";
import type { AppDeclaration } from "../../core";
import { appEntries } from "./apps.generated";

/**
 * Every app this backend's composition registers in its browser (its Apps.App
 * contributions), as data: the generated manifest's entries of the plugins the
 * composition loads (server-core's `composedOnly`). Read at request time — the
 * composition is declared by the process root before the graph loads.
 */
export function declaredApps(): readonly AppDeclaration[] {
  return composedOnly(appEntries);
}

/** One declared app with the web plugin that contributes it (dot-form id). */
export interface DeclaredAppOf {
  plugin: string;
  declaration: AppDeclaration;
}

// One array for the process: `composedOnly` memoizes per manifest array.
const appEntriesWithPlugin = appEntries.map((e) => ({
  plugin: e.plugin,
  value: { plugin: e.plugin, declaration: e.value },
}));

/**
 * {@link declaredApps}, each with its contributing web plugin — for a reader
 * that needs to know where an app's code lives (its plugin subtree), not only
 * what it is.
 */
export function declaredAppPlugins(): readonly DeclaredAppOf[] {
  return composedOnly(appEntriesWithPlugin);
}
