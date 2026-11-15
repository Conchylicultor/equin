import { useLayoutEffect, useRef, type ReactElement } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { money } from "../internal/format";

const DURATION_MS = 420;

/**
 * An amount that counts to its new value (ease-out over 420 ms) instead of
 * blinking — one number on screen, never the old and the new stacked. The
 * text is written straight to the element per frame: nothing re-renders.
 */
export function CountTo({
  value,
  className,
}: {
  value: number;
  className?: string;
}): ReactElement {
  const ref = useRef<HTMLElement>(null);
  const shown = useRef(value);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    if (from === value) {
      el.textContent = money(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      // A frame's timestamp may precede t0 (it is the frame's start): clamp.
      const k = Math.min(1, Math.max(0, (t - t0) / DURATION_MS));
      const eased = 1 - Math.pow(1 - k, 3);
      shown.current = from + (value - from) * eased;
      el.textContent = money(k < 1 ? shown.current : value);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <b ref={ref} className={cn("tabular-nums", className)} />;
}
