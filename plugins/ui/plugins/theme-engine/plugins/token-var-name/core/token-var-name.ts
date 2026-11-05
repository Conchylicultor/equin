/** The CSS custom property a token-group schema key paints: `--` + its kebab case. */
export function tokenVarName(key: string): string {
  return `--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}
