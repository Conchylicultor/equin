export interface TokenGroupField {
  /** The token's value when no theme says otherwise — in light mode, and in dark mode unless `darkDefault` is set. */
  default: string;
  /**
   * The token's dark-mode value when no theme says otherwise. Set it on every
   * token whose dark value differs (a palette's background, its text): a theme
   * that never mentions this group paints these defaults in BOTH modes, so a
   * missing `darkDefault` would paint the light colour on a dark page.
   */
  darkDefault?: string;
  label?: string;
}

export type TokenGroupSchema = Record<string, TokenGroupField>;

/** Some of a group's tokens, each mapped to its CSS value. */
export type TokenValues<T extends TokenGroupSchema = TokenGroupSchema> =
  Partial<{ [K in keyof T]: string }>;

/**
 * What one theme says about one token group: a sparse set of token values per
 * color mode. A token the fragment leaves out falls through to whatever the
 * theme's `extends` parent (and ultimately the group's schema default) says.
 */
export interface TokenGroupFragment<
  T extends TokenGroupSchema = TokenGroupSchema,
> {
  groupId: string;
  light: TokenValues<T>;
  dark: TokenValues<T>;
  /**
   * Editor-only state a section needs to edit the fragment again (the shadow
   * editor's slider params). Never read by the resolver.
   */
  meta?: Record<string, unknown>;
}

// `V` exactly, with any key the group does not declare turned into `never` — so
// a misspelled token is a tsc error even when the values arrive through
// `both(...)`, where an object literal's own excess-property check no longer
// applies.
type OnlyTokensOf<V, T extends TokenGroupSchema> = V & {
  [K in Exclude<keyof V, keyof T>]: never;
};

export interface TokenGroupDescriptor<
  T extends TokenGroupSchema = TokenGroupSchema,
> {
  id: string;
  schema: T;
  vars: { [K in keyof T]: string };
  /**
   * Build this group's fragment of a theme. Typed against the group's schema:
   * a token name the group does not declare does not compile.
   */
  fragment<L extends TokenValues<T>, D extends TokenValues<T>>(values: {
    light: OnlyTokensOf<L, T>;
    dark: OnlyTokensOf<D, T>;
    meta?: Record<string, unknown>;
  }): TokenGroupFragment<T>;
}

/**
 * A token group as data: what resolving and painting a theme reads (its id, the
 * schema defaults and the CSS variable per token), without the typed
 * `fragment` builder authors use. Every `TokenGroupDescriptor` is one; the
 * server, which receives the groups as generated data, holds only this.
 */
export type TokenGroupSpec<T extends TokenGroupSchema = TokenGroupSchema> =
  Pick<TokenGroupDescriptor<T>, "id" | "schema" | "vars">;

/** The CSS custom property a token-group schema key paints: `--` + its kebab case. */
export function tokenVarName(key: string): string {
  return `--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

export function defineTokenGroup<T extends TokenGroupSchema>(
  id: string,
  schema: T,
): TokenGroupDescriptor<T> {
  const vars = {} as Record<string, string>;
  for (const key of Object.keys(schema)) {
    vars[key] = tokenVarName(key);
  }
  return {
    id,
    schema,
    vars: vars as { [K in keyof T]: string },
    fragment: ({ light, dark, meta }) =>
      meta === undefined
        ? { groupId: id, light, dark }
        : { groupId: id, light, dark, meta },
  };
}

/** The same token values in both color modes — for a group that has no dark variant. */
export function both<V>(values: V): { light: V; dark: V } {
  return { light: values, dark: values };
}

/**
 * Does any token in `group` match the customizer's search box?
 *
 * The theme customizer's sections filter themselves by the pane-wide `search`
 * string, and every one of them filters on the SAME thing — a token's label or
 * its CSS variable name. Hoisting that predicate here gives each section one
 * expression to hand `useAvailable`, so a non-matching section disappears
 * instead of leaving a titled card the user opens onto an empty token list.
 *
 * `extraTerms` covers a section that is findable by more than its tokens — the
 * shadow editor answers to "blur" and "opacity", which are parameters of its
 * editor rather than tokens of its group.
 *
 * An empty query matches everything: no search ⇒ no filtering.
 */
export function tokenGroupMatchesSearch(
  group: TokenGroupDescriptor,
  search: string,
  extraTerms: readonly string[] = [],
): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  if (extraTerms.some((term) => term.toLowerCase().includes(q))) return true;
  return Object.keys(group.schema).some((key) => {
    const label = group.schema[key]?.label ?? key;
    const cssVar = group.vars[key] ?? "";
    return label.toLowerCase().includes(q) || cssVar.toLowerCase().includes(q);
  });
}

/**
 * The group's LIGHT schema defaults, worn in both color modes — the fragment a
 * light-only theme names for every group with a `darkDefault`, so the dark
 * switch cannot reach it. Derived from the schema, so it follows the defaults
 * as they change instead of freezing a copy of them.
 */
export function lightOnly<T extends TokenGroupSchema>(
  group: TokenGroupDescriptor<T>,
): TokenGroupFragment<T> {
  const light = Object.fromEntries(
    Object.entries(group.schema).map(([key, field]) => [key, field.default]),
  ) as TokenValues<T>;
  return { groupId: group.id, light, dark: light };
}
