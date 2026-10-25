import {
  AUDIENCES,
  reachesAudience,
  type Audience,
} from "@plugins/audience/core";

/**
 * The notifications that reach `audience`, as the `where` every bell read ANDs
 * in: those declared for an audience that reaches it, and — for anyone but a
 * developer — not muted (a muted row is noise its producer already classified;
 * only a developer has a use for it). A developer reads everything: `{}`.
 *
 * Its server twin is the badge's loader (`countUnreadNotifications`), which
 * counts per audience through the same `reachesAudience`; muted rows are never
 * counted there anyway.
 */
export function audienceScope(audience: Audience) {
  if (audience === "developer") return {};
  return {
    audience: {
      in: AUDIENCES.filter((declared) => reachesAudience(declared, audience)),
    },
    muted: false,
  };
}
