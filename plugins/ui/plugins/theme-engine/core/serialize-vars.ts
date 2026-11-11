// Pure serialization of a token group's resolved values into the
// light-and-dark CSS text painted per group. One function for both painters
// — the browser's ThemeInjector and the server that renders the first frame's
// CSS into the HTML (see paint.ts) — so the browser adopts the server's
// elements without rewriting them: the no-flash first frame depends on that
// identity.

import { ROOT_SCHEME_SELECTORS } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";

type VarsDescriptor = { vars: Record<string, string> };

/** Serialize a value map into `  --css-var: value;` lines, skipping unknown keys. */
export function buildVarsBlock(
  descriptor: VarsDescriptor,
  values: Record<string, string>,
): string {
  return Object.entries(values)
    .map(([key, value]) => {
      const cssVar = descriptor.vars[key];
      if (!cssVar) return null;
      return `  ${cssVar}: ${value};`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * The full `<light>{…}<dark>{…}` block for one token group, given resolved values.
 *
 * `selectors` defaults to the desktop's base pair — `:root` and every colour
 * scheme carrier, in its scheme (ui-kit's `ROOT_SCHEME_SELECTORS`). Scoped
 * callers pass a `[data-theme-scope]` pair instead (`themeScopeSelectors`).
 */
export function renderGroupBlock(
  descriptor: VarsDescriptor,
  light: Record<string, string>,
  dark: Record<string, string>,
  selectors: { light: string; dark: string } = ROOT_SCHEME_SELECTORS,
): string {
  return `${selectors.light} {\n${buildVarsBlock(descriptor, light)}\n}\n${selectors.dark} {\n${buildVarsBlock(descriptor, dark)}\n}`;
}
