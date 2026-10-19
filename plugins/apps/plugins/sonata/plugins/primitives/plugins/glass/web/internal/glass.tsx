import type { CSSProperties, ReactNode, Ref } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import "./glass.css";

/**
 * The corners a glass surface wears: `pill` — fully rounded ends (a bar, the
 * rail); `panel` — the 22px card corners of the expanded section panel.
 */
export type GlassShape = "pill" | "panel";

/**
 * Which glass: `bar` — the light, saturated frost every floating bar and the
 * rail share; `deep` — the progression capsule's darker glass with a heavier
 * blur, which lets the colour of the notes passing under it bleed through.
 */
export type GlassTint = "bar" | "deep";

export interface GlassProps {
  shape?: GlassShape;
  tint?: GlassTint;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
  children?: ReactNode;
}

/**
 * The player's floating surface: one material for everything that floats over
 * the notes, so no two bars can disagree on how translucent they are. The fill
 * is deliberately NOT the theme's popover: a menu must be solid (nothing behind
 * it competes with what is in it), a bar only needs to stay readable.
 *
 * A pure surface — it lays nothing out; the caller's child arranges.
 */
export function Glass({
  shape = "pill",
  tint = "bar",
  className,
  style,
  ref,
  children,
}: GlassProps) {
  return (
    <div
      ref={ref}
      data-shape={shape}
      data-tint={tint}
      className={cn("sonata-glass", className)}
      style={style}
    >
      {children}
    </div>
  );
}
