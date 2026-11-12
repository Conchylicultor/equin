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
