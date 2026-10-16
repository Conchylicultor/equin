import {
  useEffect,
  useSyncExternalStore,
  type ComponentPropsWithRef,
} from "react";
import type { IconRef, IconStyle } from "../../core";
import { useIconScope } from "./icon-scope";
import { useScopeIconStyle } from "./style-store";
import { subscribeSprites, wantSprite } from "./sprite-store";
import {
  subscribeRuntimeSymbols,
  wantRuntimeSymbol,
} from "./runtime-symbol-store";
import { resolveIconDrawing, type DrawingWant } from "./icon-drawing";

export interface IconProps extends Omit<
  ComponentPropsWithRef<"svg">,
  "children"
> {
  icon: IconRef;
  /**
   * Draw the icon in its active form — the theme's `iconActiveFill` (filled by
   * default): a selected nav item, a pinned row, an on toggle.
   */
  active?: boolean;
  /** An accessible name, drawn as the svg's `<title>`; the icon is then no longer hidden from assistive tech. */
  title?: string;
}

/** The icon style of the theme scope this component renders in. */
export function useIconStyle(): IconStyle {
  return useScopeIconStyle(useIconScope());
}

/** Subscribe to both icon stores: a sprite or a runtime-symbol chunk landing. */
export function subscribeIconStores(listener: () => void): () => void {
  const offSprites = subscribeSprites(listener);
  const offRuntime = subscribeRuntimeSymbols(listener);
  return () => {
    offSprites();
    offRuntime();
  };
}

/** Hand one want to its loader. */
export function askFor(want: DrawingWant): void {
  if (want.kind === "sprite") wantSprite(want.key);
  else wantRuntimeSymbol(want.styleKey, want.name);
}

function wantsKey(wants: readonly DrawingWant[]): string {
  return wants
    .map((w) => (w.kind === "sprite" ? w.key : `${w.styleKey}/${w.name}`))
    .join(",");
}

/**
 * Draws an `IconRef`: an `<svg>` at 1em (so `className="size-4"` and every
 * `[&_svg]:…` rule size it as before) that `<use>`s the sprite symbol for the
 * icon in its theme scope's style (`resolveIconDrawing`).
 *
 * Until that style's sprite has loaded it draws the DEFAULT style's symbol —
 * the same glyph in the global style, in the same box, which is resident from
 * first paint. Brands have one mark and ignore the style.
 *
 * A Seti file-type glyph has one style too, and its sprite is never resident:
 * the first Seti icon to mount asks the sprite host for it, and until it lands
 * the icon is an empty box at its final size (a loading state).
 *
 * In a scope whose icon family is Lucide, a symbol with a Lucide counterpart
 * draws it from the `lucide` sprite — never resident: the first such icon to
 * mount asks for it, and until it lands the icon draws its Material symbol as
 * above. A symbol with no counterpart keeps its Material drawing.
 *
 * A runtime (saved) symbol draws from the runtime symbol store the same way:
 * its style's symbol once held, the default style's while that one loads, and
 * — only for a name no chunk holds in either — an empty box at its final size
 * (a loading state) until the fetch lands.
 */
export function Icon({ icon, active = false, title, ...rest }: IconProps) {
  const style = useIconStyle();
  // Plain strings out of the store: an icon re-renders only when what it
  // draws, or what it waits for, changes.
  const id = useSyncExternalStore(
    subscribeIconStores,
    () => resolveIconDrawing(icon, style, active).drawing?.id ?? null,
  );
  const wanted = useSyncExternalStore(subscribeIconStores, () =>
    wantsKey(resolveIconDrawing(icon, style, active).wants),
  );
  useEffect(() => {
    if (wanted === "") return;
    for (const w of resolveIconDrawing(icon, style, active).wants) askFor(w);
    // `wanted` is the trigger; the rest is what it was computed from.
  }, [wanted, icon, style, active]);
  const named =
    title !== undefined ||
    rest["aria-label"] !== undefined ||
    rest["aria-labelledby"] !== undefined;
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden={named ? undefined : true}
      role={named ? "img" : undefined}
      data-icon={icon.name}
      {...rest}
    >
      {title !== undefined ? <title>{title}</title> : null}
      {id !== null ? <use href={`#${id}`} /> : null}
    </svg>
  );
}
