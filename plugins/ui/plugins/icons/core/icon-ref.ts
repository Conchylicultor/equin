import type { SetiName } from "./seti-names.generated";
import type { BrandName, SymbolName } from "./symbol-names.generated";

/** A Material Symbols icon. Its style (shape, fill, weight) is the theme's, not the call site's. */
export interface SymbolRef {
  readonly kind: "symbol";
  readonly name: SymbolName;
}

/** A brand mark (Simple Icons). Brands ignore the icon theme and always draw their own mark. */
export interface BrandRef {
  readonly kind: "brand";
  readonly name: BrandName;
}

/**
 * A Seti file-type glyph (VS Code's file icons: `typescript`, `json`, `docker`).
 * One colour (`currentColor`) and one style: like a brand it ignores the
 * theme's shape and fill axes. Its sprite is not resident — it is fetched the
 * first time a Seti icon mounts, so a surface that never shows a file pays
 * nothing.
 */
export interface SetiRef {
  readonly kind: "seti";
  readonly name: SetiName;
}

/**
 * A Material Symbols base name a USER picked and something stored (an agent's
 * avatar, a page icon), as opposed to one written in code. Only a parse that
 * checked it against the installed sets mints it (`SavedSymbolNameSchema`,
 * `ui/icons/saved-names`), so a stored name is always one `<Icon>` can draw.
 */
export type SavedSymbolName = string & {
  readonly __brand: "SavedSymbolName";
};

/**
 * A saved symbol. Unlike a {@link SymbolRef} its name is not in the build's
 * icon manifest, so the sprites do not carry it: `<Icon>` draws it from the
 * runtime symbol store (resident for every name a saved-icon source reports,
 * fetched on demand otherwise). It follows the scope's style like any symbol.
 */
export interface RuntimeSymbolRef {
  readonly kind: "runtime-symbol";
  readonly name: SavedSymbolName;
}

/**
 * A glyph an app draws itself, from its icon family (`defineIconFamily`):
 * minted by the family's `icon("…")`, which tsc checks against the family's
 * glyph names. Drawn from that family in every scope (one style, like a
 * brand); an empty box at its final size until the family is contributed.
 */
export interface CustomRef {
  readonly kind: "custom";
  readonly family: string;
  readonly name: string;
}

/**
 * An icon as DATA: which glyph, never how it looks. `<Icon icon={…}/>` draws it
 * in the style the surrounding theme scope picks, so a slot takes an `IconRef`
 * rather than a component.
 */
export type IconRef =
  SymbolRef | BrandRef | SetiRef | RuntimeSymbolRef | CustomRef;

/**
 * A Material Symbols icon by its base name (`"forum"`, `"open-in-new"`). The
 * argument must be a string literal (lint `icons/literal-icon-name`): the build
 * collects every literal into the icon manifest, and only manifest names ship in
 * the sprites. An unknown name is a tsc error.
 */
export function symbol(name: SymbolName): SymbolRef {
  return { kind: "symbol", name };
}

/** A brand mark by its Simple Icons slug (`"github"`, `"notion"`). String literal only, like {@link symbol}. */
export function brand(name: BrandName): BrandRef {
  return { kind: "brand", name };
}

/**
 * A Seti file-type glyph by its name in the vendored set (`"typescript"`,
 * `"docker"`). String literal only, like {@link symbol}: the build ships exactly
 * the names some code writes.
 */
export function seti(name: SetiName): SetiRef {
  return { kind: "seti", name };
}

/**
 * A saved (user-picked) symbol. Takes a {@link SavedSymbolName} — a name a
 * parse checked — rather than a literal, so it is its own constructor, outside
 * `icons/literal-icon-name` and the manifest scan: its glyph is loaded at
 * runtime instead of shipping in the sprites.
 */
export function runtimeSymbol(name: SavedSymbolName): RuntimeSymbolRef {
  return { kind: "runtime-symbol", name };
}
