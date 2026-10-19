import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { refreshSavedThemes } from "./refresh-saved-themes";

// Pre-paint hydration of the saved-theme list. The theme painter resolves each
// scope's selected theme on the first frame; without this task the list
// arrives only after mount, so the resident source reports pending and no theme
// styles are injected until it resolves. Hydrating here makes the first
// injection the correct one. Failure degrades gracefully (`ifUnavailable:
// "continue"`): boot proceeds without it, the source stays pending, and the
// first-frame CSS the server painted into the HTML (theme-engine/server) keeps
// painting until the endpoint resolves.
export const savedThemesBootTask = Core.Boot({
  label: "Saved themes",
  ifUnavailable: "continue",
  run: refreshSavedThemes,
});
