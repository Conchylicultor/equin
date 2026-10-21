import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useInView } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { createFilingsField, type Recede } from "../internal/filings";

export interface AmbientFieldProps {
  /** The content the field lives behind. It fills the field's box. */
  children: ReactNode;
  /** An element (the page's text column) the field recedes behind, so what
   *  sits over it stays clean. Omitted: the field is even everywhere. */
  recedeBehind?: RefObject<HTMLElement | null>;
  className?: string;
}

/** What the mounted canvas exposes to the size and visibility watchers. */
interface Painter {
  resize(): void;
  setVisible(visible: boolean): void;
}

/**
 * A living, barely-there background behind `children`: hairline strands that
 * follow a slowly turning flow, like iron filings revealing a field. It moves
 * on its own; each pointer stroke is a magnet of its own random kind that turns
 * the strands near it, then fades. Strands are drawn in the theme's primary text
 * colour at a very low alpha.
 *
 * Animates only while on screen; under reduced motion it is a still frame.
 */
export function AmbientField({
  children,
  recedeBehind,
  className,
}: AmbientFieldProps) {
  const hostRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painter = useRef<Painter | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (host === null || canvas === null)
      throw new Error("AmbientField: refs not attached");
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("AmbientField: no 2d canvas context");
    const field = createFilingsField();
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let prev = performance.now();
    const draw = (now: number) => {
      const dt = reduceMotion ? 0 : Math.min(0.05, (now - prev) / 1000);
      prev = now;
      // Read the colour each frame: a theme switch repaints without a remount.
      field.frame(
        ctx,
        dt,
        reduceMotion ? 0 : now,
        getComputedStyle(canvas).color,
      );
    };
    const loop = (now: number) => {
      draw(now);
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    painter.current = {
      resize() {
        const box = host.getBoundingClientRect();
        const dpr = devicePixelRatio || 1;
        canvas.width = Math.round(box.width * dpr);
        canvas.height = Math.round(box.height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const quiet = recedeBehind?.current?.getBoundingClientRect();
        const recede: Recede | null = quiet
          ? { left: quiet.left - box.left, right: quiet.right - box.left }
          : null;
        field.resize(box.width, box.height, recede);
        // A resize clears the canvas; repaint now unless the loop will.
        if (raf === 0) draw(performance.now());
      },
      // Off screen (a background tab of the app, scrolled away): no frames.
      setVisible(visible) {
        if (!visible) stop();
        else if (!reduceMotion && raf === 0) {
          prev = performance.now();
          raf = requestAnimationFrame(loop);
        }
      },
    };
    painter.current.resize();

    const move = (e: PointerEvent) => {
      if (reduceMotion) return;
      const box = host.getBoundingClientRect();
      field.pointer(
        e.clientX - box.left,
        e.clientY - box.top,
        performance.now(),
      );
    };
    const leave = () => field.release();
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", leave);

    return () => {
      stop();
      painter.current = null;
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
    };
  }, [recedeBehind]);

  useResizeObserver(
    recedeBehind ? [hostRef, recedeBehind] : hostRef,
    () => painter.current?.resize(),
    { deps: [recedeBehind] },
  );
  useInView(hostRef, (entry) =>
    painter.current?.setVisible(entry.isIntersecting),
  );

  return (
    <Overlay
      ref={hostRef}
      fill
      className={cn("h-full w-full", className)}
      behind={
        <canvas
          ref={canvasRef}
          aria-hidden
          className="block h-full w-full text-primary-text"
        />
      }
    >
      {children}
    </Overlay>
  );
}
