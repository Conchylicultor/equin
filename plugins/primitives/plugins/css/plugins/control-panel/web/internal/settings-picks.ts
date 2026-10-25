import type { RolePart } from "@plugins/primitives/plugins/css/plugins/text/core";

/**
 * The settings card's three picked parts, read by `<Text pick>`: the card's
 * title, a section's heading and a section's prose. Their tokens are the
 * overlay group's `settingsTitle*` / `settingsHeading*` / `settingsProse*`
 * (`ui/tokens/overlay`), named here by CSS var — the way any component reads
 * a token — because this plugin cannot import that group (theme-engine, which
 * defines it, reaches back here through config_v2). Each fallback is its
 * role token's default, drawn while the token is unset.
 */
export const SETTINGS_TITLE: RolePart = {
  role: "--settings-title-role",
  emphasis: "--settings-title-emphasis",
  family: "--settings-title-family",
  fallback: "subheading",
};

export const SETTINGS_HEADING: RolePart = {
  role: "--settings-heading-role",
  emphasis: "--settings-heading-emphasis",
  family: "--settings-heading-family",
  fallback: "label",
};

export const SETTINGS_PROSE: RolePart = {
  role: "--settings-prose-role",
  emphasis: "--settings-prose-emphasis",
  family: "--settings-prose-family",
  fallback: "caption",
};
