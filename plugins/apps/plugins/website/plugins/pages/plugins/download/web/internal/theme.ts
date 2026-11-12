import { both, defineSubTheme } from "@plugins/ui/plugins/theme-engine/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";

/**
 * The download page's body sizes, worn over the site's `equin-document`. An
 * install page is read up close, step by step, so it sets in a smaller hand
 * than the essay pages. Each role re-valued here is the one the page's text
 * already speaks through:
 *
 * - `title` 22px/1.6 — "One command" / "One prompt".
 * - `heading` 17px/1.6 — the try-the-demo card's heading.
 * - `subheading` 15px/1.6 — a next step's title; the agent prompt (regular).
 * - `body` 14px/1.5 — a step's line, the installer's steps, the demo card's line.
 * - `label` 14px/1.6 — the site's own: "Then open …", "What does install.sh do?".
 * - `caption` 12px/1.6 — the site's own: the eyebrow, a step's number.
 * - `code` 13.5px/1.6 — the install command.
 * - `tag` 13.5px/1.6, medium — For you / For your agent.
 *
 * The rhythm inside the column (4 / 5 / 8 / 10 / 12 / 14 / 22 / 24 / 28px)
 * and an 8px radius step (the copy button's corner). The larger distances —
 * 48px to the caveats and the demo card, 64px to "Once it is running" — are the
 * page's score, in `download.css`.
 */
export const equinDownloadTheme = defineSubTheme({
  id: "equin-download",
  label: "equin download",
  fragments: [
    typeScaleGroup.fragment(
      both({
        fontSizeTitle: "1.375rem",
        lineHeightTitle: "2.2rem",
        fontSizeHeading: "1.0625rem",
        lineHeightHeading: "1.7rem",
        fontSizeSubheading: "0.9375rem",
        lineHeightSubheading: "1.5rem",
        fontSizeBody: "0.875rem",
        lineHeightBody: "1.3125rem",
        fontSizeCode: "0.84375rem",
        lineHeightCode: "1.35rem",
        fontSizeTag: "0.84375rem",
        lineHeightTag: "1.35rem",
        fontWeightTag: "500",
      }),
    ),
    densityGroup.fragment(
      both({
        // 4px — a step's title and its line; the demo card's heading and line.
        "space-2xs": "0.25rem",
        // 5px — between two installer steps, two caveats.
        "space-xs": "0.3125rem",
        // 8px — a step's line and its link.
        "space-xsm": "0.5rem",
        // 10px — the disclosure's chevron and its words; two agent buttons.
        "space-sm": "0.625rem",
        // 12px — the command and its copy button; the caveats' icon and text;
        // the disclosure and its steps.
        "space-smd": "0.75rem",
        // 14px — a heading and its panel; the panel and the line under it; a
        // step's number and its title.
        "space-md": "0.875rem",
        // 22px — the demo card's picture and its words.
        "space-lg": "1.375rem",
        // 24px — the eyebrow and the steps.
        "space-xl": "1.5rem",
        // 28px — the tabs and the heading; the line and the disclosure;
        // between two steps.
        "space-2xl": "1.75rem",
      }),
    ),
    shapeGroup.fragment(both({ radius: "0.5rem" })),
  ],
});

/**
 * The caveats note's one size over `equinDownloadTheme`: its words on the
 * `caption` role at 13.5px/1.55 — a half-step under the page's 14px body, the
 * small print before installing, while the eyebrow keeps the 12px caption.
 */
export const equinDownloadNoteTheme = defineSubTheme({
  id: "equin-download-note",
  label: "equin download note",
  fragments: [
    typeScaleGroup.fragment(
      both({
        fontSizeCaption: "0.84375rem",
        lineHeightCaption: "1.3078125rem",
      }),
    ),
  ],
});

/**
 * The audience switch's one size over `equinDownloadTheme`: a segment's words
 * (a `ToggleChip` reads `caption`) at 13.5px/1.6, medium — so a segment is
 * 34px tall with its 6px above and below — while the page's eyebrow and step
 * numbers keep the 12px caption.
 */
export const equinDownloadTabsTheme = defineSubTheme({
  id: "equin-download-tabs",
  label: "equin download tabs",
  fragments: [
    typeScaleGroup.fragment(
      both({
        fontSizeCaption: "0.84375rem",
        lineHeightCaption: "1.35rem",
      }),
    ),
  ],
});
