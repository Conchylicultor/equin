import { useLayoutEffect, useRef } from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { ANIMATION_HOST } from "@plugins/reports/plugins/render-loop/core";
import type { HeadFigure as Figure } from "../internal/kit";

/**
 * The host both head figures draw into: React renders it once, the figure
 * owns its shadow root from mount on (and its rAF loop while on screen), and
 * is laid out again when the host's width changes.
 */
export function HeadFigureHost({
  mount,
}: {
  mount: (host: HTMLElement) => Figure;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const figureRef = useRef<Figure | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const figure = mount(host);
    figureRef.current = figure;
    return () => {
      figureRef.current = null;
      figure.dispose();
    };
  }, [mount]);

  useResizeObserver(hostRef, () => figureRef.current?.layout());

  return <div ref={hostRef} {...ANIMATION_HOST} />;
}
