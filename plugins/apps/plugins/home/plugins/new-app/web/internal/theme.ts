import { both, defineSubTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";

/**
 * The New app prompt's own box, from the mock (`proto-1792811301-yksedx`,
 * `.composer` / `.comp-bar`): 16px corners, the text inset 18px (6px above the
 * bar), the bar inset 10px (12px at its start), and the page's `--surface`
 * fill — Home's card colour, so it follows Home's palette in both modes. Only
 * this one field wears it (a sub-theme over Home's theme): every other card and
 * composer in Home keeps the standard values, and the launch-option popovers
 * opened from the bar leave it.
 */
export const newAppPromptTheme = defineSubTheme({
  id: "home-new-app-prompt",
  label: "New app prompt",
  fragments: [
    shapeGroup.fragment(both({ radiusCard: "1rem" })),
    densityGroup.fragment(
      both({
        padComposerText: "1.125rem 1.125rem 0.375rem",
        padComposerActions: "0.625rem 0.625rem 0.625rem 0.75rem",
      }),
    ),
    colorPaletteGroup.fragment(both({ composer: "var(--card)" })),
  ],
});
