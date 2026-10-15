/**
 * ui-kit's runtime-agnostic surface (and where its stylesheet lives). It imports nothing at all, which is what
 * lets any plugin's `core` — the lowest tier of the DAG — name a `ClassName`
 * field without dragging React, Tailwind, or a bundler in behind it.
 *
 * The *value* half stays in `web`: `cn()` is the only minter of a `ClassName`,
 * and it needs the generated twMerge registry. Consumers import the type from
 * here and the function from `…/ui-kit/web`.
 */
export type { ClassName } from "./class-name";
export { APP_STYLESHEET_PATH } from "./app-stylesheet";
