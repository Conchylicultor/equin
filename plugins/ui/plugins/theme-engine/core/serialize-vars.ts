// Pure serialization of a token group's resolved values into the
// `:root{…}.dark{…}` CSS text painted per group. One function for both painters
// — the browser's ThemeInjector and the server that renders the first frame's
// CSS into the HTML (see paint.ts) — so the browser adopts the server's
// elements without rewriting them: the no-flash first frame depends on that
// identity.

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
 * `selectors` defaults to the global `:root` / `.dark` pair. Scoped callers (per-window desktop overrides) pass a `[data-theme-scope]`
 * pair instead, e.g. `{ light: '[data-theme-scope="app:x"]', dark: '.dark [data-theme-scope="app:x"]' }`.
 */
export function renderGroupBlock(
  descriptor: VarsDescriptor,
  light: Record<string, string>,
  dark: Record<string, string>,
  selectors: { light: string; dark: string } = { light: ":root", dark: ".dark" },
): string {
  return `${selectors.light} {\n${buildVarsBlock(descriptor, light)}\n}\n${selectors.dark} {\n${buildVarsBlock(descriptor, dark)}\n}`;
}
