// The Iconify sets the sprites are built from, IMPORTED rather than looked up
// in node_modules at runtime: a released backend is a `bun --compile` binary
// with no node_modules beside it, where `import.meta.resolve` of a package
// throws at module eval and the backend never boots. `type: "file"` makes the
// bundler embed each set as an asset and yields its path — on disk in dev,
// under /$bunfs in a binary — so it is read lazily and boot parses nothing.
//
// Plain JS with a hand-written `icon-sets.d.ts`: tsc types a JSON import by its
// CONTENT whatever its import attribute says, so a `.ts` spelling would type
// each path as a 10 MB object (and load it into every type-check).
import brandsFile from "@iconify-json/simple-icons/icons.json" with { type: "file" };
import brandsPackage from "@iconify-json/simple-icons/package.json" with { type: "json" };
import lucideFile from "@iconify-json/lucide/icons.json" with { type: "file" };
import lucidePackage from "@iconify-json/lucide/package.json" with { type: "json" };
import lightFile from "@iconify-json/material-symbols-light/icons.json" with { type: "file" };
import lightPackage from "@iconify-json/material-symbols-light/package.json" with { type: "json" };
import regularFile from "@iconify-json/material-symbols/icons.json" with { type: "file" };
import regularPackage from "@iconify-json/material-symbols/package.json" with { type: "json" };

export const ICON_SETS = {
  regular: { name: regularPackage.name, version: regularPackage.version, file: regularFile },
  light: { name: lightPackage.name, version: lightPackage.version, file: lightFile },
  brands: { name: brandsPackage.name, version: brandsPackage.version, file: brandsFile },
  lucide: { name: lucidePackage.name, version: lucidePackage.version, file: lucideFile },
};
