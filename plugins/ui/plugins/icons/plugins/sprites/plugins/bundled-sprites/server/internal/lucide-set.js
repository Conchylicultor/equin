// The Lucide set a browser host draws its `lucide` sprites from, bundled with
// the page's worker and loaded lazily: fetched only the first time a Lucide
// scope (an app whose theme picks Lucide, such as Files) mounts an icon.
//
// Plain JS with a hand-written `lucide-set.d.ts`: tsc types a JSON import by
// its CONTENT, so a `.ts` spelling would type the set as a large object (and
// load it into every type-check) — as `bundled-symbols`' set does.
import lucidePackage from "@iconify-json/lucide/package.json" with { type: "json" };

export const LUCIDE_SET = {
  name: lucidePackage.name,
  version: lucidePackage.version,
  load: () => import("@iconify-json/lucide/icons.json").then((m) => m.default),
};
