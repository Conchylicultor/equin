import {
  definedTokenGroup,
  type TokenGroupFragment,
  type TokenGroupSpec,
} from "./define-token-group";

/**
 * The token groups a scope paints: every group it registers
 * (`ThemeEngine.TokenGroup`), then every group a contributed CODE theme names —
 * a theme, sub-theme or fixed theme — that the scope does not register.
 *
 * A code theme carries its groups. It builds each fragment with its group's
 * `fragment()`, so the group's definition evaluated with the theme, and a
 * contributed code theme naming an unregistered group has no spelling: if the
 * group's registering plugin failed to load (every token plugin's web barrel
 * also pulls in the theme customizer, so one failed artifact there takes them
 * all out) or is absent from the composition, the group still paints its
 * schema defaults under the theme's values — that plugin's load failure is
 * reported on its own (plugin-load-errors), not echoed once per fragment. Only a STORED theme (saved, tweakcn) can still name a
 * group no code defines; the resolver drops and reports it.
 *
 * Registered groups keep their order and win on id; the rest follow in the
 * order the themes name them. Returns `registered` itself when every named
 * group is registered, so a caller memoizing on it re-renders nothing.
 */
export function paintedTokenGroups(
  registered: readonly TokenGroupSpec[],
  codeThemes: readonly { fragments: readonly TokenGroupFragment[] }[],
): readonly TokenGroupSpec[] {
  const known = new Set(registered.map((g) => g.id));
  const carried: TokenGroupSpec[] = [];
  for (const theme of codeThemes) {
    for (const { groupId } of theme.fragments) {
      if (known.has(groupId)) continue;
      const group = definedTokenGroup(groupId);
      if (group === undefined) continue;
      known.add(groupId);
      carried.push(group);
    }
  }
  return carried.length === 0 ? registered : [...registered, ...carried];
}
