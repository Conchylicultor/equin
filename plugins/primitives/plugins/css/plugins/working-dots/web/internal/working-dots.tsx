import { useEffect, useId, useRef } from "react";
import {
  cn,
  useControlSize,
  type ControlSize,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useInView } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { createDotsEngine, type WorkingMood } from "./engine";
import "./working-dots.css";

export interface WorkingDotsProps extends DensityControlled {
  /** What the agent is doing; retunes the motion live. Default `working`. */
  mood?: WorkingMood;
  className?: string;
}

/** Dot diameter per density tier, as the CSS variable the geometry reads… */
const SIZE_MAP: Record<ControlSize, string> = {
  xs: "[--wd-dot:4px]",
  sm: "[--wd-dot:4px]",
  md: "[--wd-dot:6px]",
  lg: "[--wd-dot:8px]",
};
/** …and in px, for the goo blur, which must scale with the dot or small dots erode away. */
const DOT_PX: Record<ControlSize, number> = { xs: 4, sm: 4, md: 6, lg: 8 };

const DOTS = [0, 1, 2];

/**
 * Three dots that say "working", moving organically: varied passes, springs,
 * holds with a breath, and a style mix set by `mood`. See CLAUDE.md.
 */
export function WorkingDots({ mood = "working", className }: WorkingDotsProps) {
  const size = useControlSize();
  const filterId = `working-dots-goo-${useId().replace(/:/g, "")}`;
  const rowRef = useRef<HTMLSpanElement>(null);
  const engineRef = useRef<ReturnType<typeof createDotsEngine> | null>(null);
  const moodRef = useRef(mood);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const dots = [...row.querySelectorAll<HTMLElement>(".working-dots-dot")];
    const halos = [...row.querySelectorAll<HTMLElement>(".working-dots-halo")];
    const engine = createDotsEngine({ dots, halos }, moodRef.current);
    engineRef.current = engine;
    return () => {
      engine.stop();
      engineRef.current = null;
    };
  }, [filterId]);

  // Only animate while on screen: a keep-alive tab hidden with display:none keeps rAF running.
  // Declared after the engine's effect, and rebuilt with it, so it always drives the live engine.
  useInView(
    rowRef,
    (entry) => {
      if (entry.isIntersecting) engineRef.current?.start();
      else engineRef.current?.stop();
    },
    { deps: [filterId] },
  );

  useEffect(() => {
    moodRef.current = mood;
    engineRef.current?.setMood(mood);
  }, [mood]);

  return (
    <span
      ref={rowRef}
      aria-hidden
      className={cn(
        "working-dots text-primary-text",
        SIZE_MAP[size],
        className,
      )}
    >
      {/* The gooey filter: blur, then a hard alpha threshold, so touching dots melt into one.
          EVERY style draws through it, so a dot is the same size whatever the style. */}
      <svg width="0" height="0" className="absolute">
        <filter id={filterId} x="-100%" y="-150%" width="300%" height="400%">
          <feGaussianBlur
            in="SourceGraphic"
            stdDeviation={(1.6 * DOT_PX[size]) / 6}
            result="b"
          />
          <feColorMatrix
            in="b"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 16 -7"
          />
        </filter>
      </svg>
      {/* Halos on their own layer: through the filter, a soft halo would threshold into a solid blob. */}
      <span className="working-dots-layer">
        {DOTS.map((i) => (
          <span key={i} className="working-dots-halo" />
        ))}
      </span>
      <span
        className="working-dots-layer"
        style={{ filter: `url(#${filterId})` }}
      >
        {DOTS.map((i) => (
          <span key={i} className="working-dots-dot" />
        ))}
      </span>
    </span>
  );
}
