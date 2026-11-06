// The Material Symbols set (weight 400: every shape, both fills) a browser
// host draws saved icons from, bundled with the page's worker and loaded
// lazily: 8.2 MB of JSON (1.3 MB compressed) fetched only the first time a
// name or style the host's storage lacks is wanted — an icon picker's grid,
// a theme's other style. The light (300) set is not bundled: a light style
// draws its nearest drawing at 400 (`resolveSymbolStyle`).
//
// Plain JS with a hand-written `bundled-set.d.ts`: tsc types a JSON import by
// its CONTENT, so a `.ts` spelling would type the set as an 8 MB object (and
// load it into every type-check) — as the desktop's `icon-sets.js` does.
import regularPackage from "@iconify-json/material-symbols/package.json" with { type: "json" };

export const BUNDLED_SET = {
  name: regularPackage.name,
  version: regularPackage.version,
  load: () =>
    import("@iconify-json/material-symbols/icons.json").then((m) => m.default),
};
