import { useEffect, useRef } from "react";
import { useDesktop } from "../internal/desktop-runtime";

/**
 * A headless full-bleed box over the desktop that lends its size to the
 * imperative commands (overview, tile all) — they lay windows out in desktop
 * pixels but hold no DOM of their own. Measured on demand, never tracked.
 */
export function DeskFrame() {
  const ref = useRef<HTMLDivElement>(null);
  const desk = useDesktop();
  useEffect(
    () =>
      desk.setDeskBoundsReader(() => {
        const r = ref.current?.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0
          ? { width: r.width, height: r.height }
          : null;
      }),
    [desk],
  );
  return (
    <div
      ref={ref}
      aria-hidden
      // eslint-disable-next-line layout/no-adhoc-layout -- an invisible full-bleed measuring box over the desktop backdrop; it paints and catches nothing
      className="pointer-events-none invisible absolute inset-0"
    />
  );
}
