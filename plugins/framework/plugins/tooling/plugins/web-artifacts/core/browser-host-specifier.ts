// A browser host is served through the import map as `@browser-host/<pluginPath>`
// (see `internal/browser-hosts.ts`): a bare specifier external to every
// artifact build and never an npm package, so neither the vendor set nor the
// barrel closure ever reads it.

export const BROWSER_HOST_SPECIFIER_PREFIX = "@browser-host/";

export function isBrowserHostSpecifier(id: string): boolean {
  return id.startsWith(BROWSER_HOST_SPECIFIER_PREFIX);
}
