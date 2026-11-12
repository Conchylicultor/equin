/**
 * The custom-property names a region publishes. Nothing else — no values, no
 * resolver, no React.
 *
 * The utilities that DECLARE these (`rail-<step>` / `rail-x-` / `rail-y-` /
 * `rail-owe-`, plus `rail-bleed` and `rail-follow` which read them) live in
 * ui-kit's `app.css`, because that is the single home for every `@utility` in
 * the project. What a name is spelled cannot live there too: a
 * `getComputedStyle` read or a `style={{…}}` publication has to pass the string,
 * and a string typed out at each site is a rename that silently half-lands. So
 * the CSS owns the behaviour and this owns the spelling, joined by these.
 */

/** Inline start of the region — where a child's content edge sits. */
export const RAIL_START_VAR = "--rail-start";

/** Inline end of the region. */
export const RAIL_END_VAR = "--rail-end";

/** Block start of the region — read by `scroll-fade`'s top edge strip. */
export const RAIL_BLOCK_START_VAR = "--rail-block-start";

/** Block end of the region — read by `scroll-fade`'s bottom edge strip. */
export const RAIL_BLOCK_END_VAR = "--rail-block-end";

/**
 * Inline start a FOLLOWER must still apply itself (`rail-follow`). Zero when the
 * region already paid its own rail; equal to the rail when it published without
 * padding. Publishing `RAIL_START_VAR` alone lands in the second arm, which is
 * the right default for a hand-published rail — but it means a hand-published
 * rail on a box that ALSO pads will double-inset every follower inside it. Set
 * both, or reach for the `rail-<step>` / `rail-owe-<step>` classes.
 */
export const RAIL_OWED_START_VAR = "--rail-owed-start";

/** Inline end a follower must still apply itself. See {@link RAIL_OWED_START_VAR}. */
export const RAIL_OWED_END_VAR = "--rail-owed-end";

/**
 * Inline start of the region's TEXT — the rail plus the row pad of a region
 * whose content is padded rows (`rail-rows`), else the rail itself. What a band
 * or a label re-applies so its text lines up with the rows' text. Published by
 * every rail class; a hand-published region publishes none, so read it with a
 * fallback to {@link RAIL_START_VAR}.
 */
export const RAIL_TEXT_START_VAR = "--rail-text-start";

/** Inline end of the region's text. See {@link RAIL_TEXT_START_VAR}. */
export const RAIL_TEXT_END_VAR = "--rail-text-end";
