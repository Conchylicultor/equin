/** One `defineSubTheme({ id: "…" })` call found in source. */
export interface DeclaredSubTheme {
  id: string;
  /** Repo-relative path of the declaring file. */
  path: string;
  line: number;
}

/** A real-code `defineSubTheme(` call — the function's own declaration is not one. */
export const SUB_THEME_CALL = /(?<!function\s+)\bdefineSubTheme\(/;

/**
 * The id a `defineSubTheme(` call on 1-based `line` of `source` declares, or
 * undefined when it is not spelled as the call's first key, a string literal —
 * the spelling every declaration uses, so the check never passes by not
 * reading one.
 */
export function readSubThemeId(
  source: string,
  line: number,
): string | undefined {
  const before = source.split("\n").slice(0, line - 1);
  const rest = source.slice(before.reduce((n, l) => n + l.length + 1, 0));
  const call = SUB_THEME_CALL.exec(rest);
  if (!call) return undefined;
  return /^\(\s*\{\s*id:\s*"([^"]+)"/.exec(
    rest.slice(call.index + "defineSubTheme".length),
  )?.[1];
}

/** The declared sub-themes no `ThemeEngine.SubTheme` contribution paints. */
export function uncontributedSubThemes(
  declared: readonly DeclaredSubTheme[],
  contributedIds: ReadonlySet<string>,
): DeclaredSubTheme[] {
  return declared.filter((d) => !contributedIds.has(d.id));
}
