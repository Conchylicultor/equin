import type { AppRef } from "@plugins/primitives/plugins/pane/core";

/**
 * One app the browser registers, as data the server can read: its whole
 * {@link AppRef} and how picking it launches — `tab` (a tab at its base path:
 * it owns a URL) or `surface` (a surface mode: no tab, no URL). The server's
 * copy of the `Apps.App` contributions, generated at build time
 * (`declaredApps`, `apps-core/server`).
 */
export interface AppDeclaration {
  app: AppRef;
  launch: "tab" | "surface";
}
