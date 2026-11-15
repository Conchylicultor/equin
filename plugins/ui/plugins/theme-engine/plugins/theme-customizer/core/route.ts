import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * The customizer opens inside whichever app you are currently in — it styles
 * that app's theme scope — so callers compose
 * `activeApp.path + themeCustomizerRoute.path({})` rather than one fixed link.
 * Keeping the segment here rather than inline at call sites means a rename
 * still propagates to every link.
 *
 * In `core/`, not beside the pane in `web/`: a link to the customizer (the
 * quick-theme popover's footer) must not load the customizer's web barrel — the
 * popover has to work when the editor fails to load
 * (`theme-customizer:painting-off-the-editor`).
 */
export const themeCustomizerRoute = defineRoute({
  id: "theme-customizer",
  segment: "theme-customizer",
});
