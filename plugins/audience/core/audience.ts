import { symbol } from "@plugins/ui/plugins/icons/core";

/**
 * Who the user is. A feature declares which audience it is for (an app's
 * `defineApp({ audience })`) rather than branching on a flag; the user's own
 * audience is the Developer mode setting (`useAudience` / `getAudience`).
 *
 *  - `user` — a regular user: developer tools stay out of the way;
 *  - `developer` — someone building equin itself.
 */
export type Audience = (typeof AUDIENCES)[number];

/** Every {@link Audience}. */
export const AUDIENCES = ["user", "developer"] as const;

/**
 * Whether a feature declared for `declared` reaches `audience`. A feature that
 * declares nothing is for everyone; a developer reaches every feature.
 */
export function reachesAudience(
  declared: Audience | undefined,
  audience: Audience,
): boolean {
  return (
    declared === undefined || declared === "user" || audience === "developer"
  );
}

/**
 * The developer symbol: the glyph of Developer mode itself (its switch) and of
 * the mark on everything only a developer is shown (`audience/developer-mark`),
 * so one symbol means "developer" on every surface.
 */
export const developerSymbol = symbol("code");
