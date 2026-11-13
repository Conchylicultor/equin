import type { FileFold } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  findMarkerCalls,
  parseStringField,
} from "@plugins/plugin-meta/plugins/parse-utils/core";

// The `defineApp({...})` an app shell's `core/*.ts` writes, read statically —
// and, over every plugin's `core/*.ts`, as a fold kept along the directory
// tree: a file's app is a function of its bytes alone, so a pass after an edit
// reads only the edited `core/` files, never every plugin's `core/` on disk.

/** `icon: symbol("…")` in a `defineApp({...})` argument: the glyph name. */
const ICON_SYMBOL = /\bicon:\s*symbol\(\s*["']([^"']+)["']\s*\)/;

/** What one file's `defineApp({...})` declares. */
export interface DefineAppCall {
  /** The app id (`defineApp({ id })`). */
  id: string;
  /** The Material Symbols name of its `icon: symbol("…")`, or null when the call declares none. */
  iconKey: string | null;
}

/**
 * The app `text` declares — its first genuine `defineApp(…)` call with an
 * object-literal argument (a call in a comment or string never counts, nor the
 * `function defineApp(def: …)` declaration itself) — or null. A `defineApp`
 * without a literal `id` throws, naming `file`: an app the build cannot name
 * is not one to guess at.
 */
export function defineAppCallIn(
  text: string,
  file: string,
): DefineAppCall | null {
  const body = findMarkerCalls(text, "defineApp")
    .map((c) => c.argsText.trim())
    .find((a) => a.startsWith("{"));
  if (body === undefined) return null;
  const id = parseStringField(body, "id");
  if (id.kind !== "value") {
    throw new Error(
      `${file} calls defineApp(...) without a string-literal \`id\`. ` +
        `Composition homes and releases read app ids statically — write it as a literal.`,
    );
  }
  return { id: id.value, iconKey: ICON_SYMBOL.exec(body)?.[1] ?? null };
}

/** Each file declaring an app, in path order: its repo-relative path and the call. */
export const declaredAppsFold: FileFold<
  null,
  (DefineAppCall & { rel: string })[]
> = {
  url: import.meta.url,
  scan(src, rel) {
    const call = defineAppCallIn(src, rel);
    return call === null ? [] : [{ ...call, rel }];
  },
  combine: (parts) => parts.flat(),
};
