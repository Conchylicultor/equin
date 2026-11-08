// Pure helpers for the map-in-sync check: deployed-dist extraction (import
// map + entry script from index.html).

/** The inline `<script type="importmap">` payload of a composed index.html. */
export function extractImportMap(html: string): Record<string, string> | null {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) return null;
  const parsed = JSON.parse(m[1]!) as { imports?: Record<string, string> };
  return parsed.imports ?? null;
}

/** The entry module script src of a composed index.html. */
export function extractEntryScriptSrc(html: string): string | null {
  const m = html.match(/<script type="module" src="([^"]+)"><\/script>/);
  return m ? m[1]! : null;
}
