/**
 * Whether the route path `path` (the address bar's, its surface-mode prefix
 * stripped) shows the page at `pagePath` — the page itself or its keyed /
 * nested suffixes.
 */
export function pathShowsPage(path: string, pagePath: string): boolean {
  if (!path.startsWith(pagePath)) return false;
  const after = path.charAt(pagePath.length);
  return after === "" || after === "/" || after === ";";
}
