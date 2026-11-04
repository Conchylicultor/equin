import { memo, useId, useLayoutEffect, useRef } from "react";
import { observeSectionReach } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";
import { findScrollParent } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { LADDER } from "../internal/ladder";
import {
  mountLadderScroll,
  type LadderScroll,
} from "../internal/ladder-scroll";
import { VisionOpening } from "./vision-opening";
import "./vision-zoom.css";

/**
 * The vision page's body: the heading, then the vision as one Powers of Ten
 * zoom-out on a dark starfield — a pinned stage behind six chapter cards,
 * each card one frame of the zoom, from an idea to every app — with a layer
 * strip pinned under the site header while it is read. The heading dissolves
 * into the zoom as the page moves.
 *
 * React renders the ladder's markup once (memoised, no props) and never
 * re-renders it: the scroll skeleton (`internal/ladder-scroll.ts`) and the zoom
 * (`internal/zoom.ts`) own the DOM from mount on, exactly as the prototype's
 * scripts owned theirs.
 *
 * Analytics: each chapter card records `section_reach` as `vision/<key>` when
 * it reaches the upper half of the screen (the heading records `vision/hero`
 * itself).
 */
export function VisionZoom() {
  const rootRef = useRef<HTMLDivElement>(null);
  const ladderRef = useRef<LadderScroll | null>(null);
  // a page-unique prefix for the drawing's ids (gradients, clip paths, timeline parts)
  const prefix = `v${useId().replace(/[^\w-]/g, "")}`;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ladder = mountLadderScroll(root, LADDER, prefix);
    ladderRef.current = ladder;
    const cards = [...root.querySelectorAll<HTMLElement>(".vs-card")];
    const reach = cards.map((el, i) =>
      observeSectionReach(el, `vision/${LADDER[i]!.key}`),
    );
    return () => {
      ladderRef.current = null;
      for (const stop of reach) stop();
      ladder.dispose();
    };
  }, [prefix]);

  // the pane's viewport is the zoom's "screen", and the page's height moves the cards: refit on either
  useResizeObserver(
    () =>
      rootRef.current
        ? [findScrollParent(rootRef.current), rootRef.current]
        : null,
    () => ladderRef.current?.resize(),
  );

  return (
    <div ref={rootRef} className="vision-zoom">
      <div className="vision-zoom-hero">
        <VisionOpening />
      </div>
      <LadderMarkup />
    </div>
  );
}

/** The ladder's static markup. Memoised with no props, so React never touches it after mount. */
const LadderMarkup = memo(function LadderMarkup() {
  return (
    <section className="vs">
      <div className="vs-strip-pin">
        <div className="vs-strip">
          <div className="vs-strip-seg">
            {LADDER.map((l) => (
              <button
                key={l.key}
                type="button"
                title={l.name}
                aria-label={l.name}
              />
            ))}
          </div>
          <div className="vs-strip-label">
            <b />
            <span />
          </div>
        </div>
      </div>
      <div className="vs-stage" aria-hidden="true" />
      <div className="vs-track">
        {LADDER.map((l) => (
          <section key={l.key} className="vs-step" id={`layer-${l.key}`}>
            <article className="vs-card">
              <h2 className="vs-card-title">{l.title}</h2>
              <div className="vs-card-body">
                {l.before && <p className="vs-before">{l.before}</p>}
                <p className="vs-after">{l.after}</p>
              </div>
            </article>
          </section>
        ))}
      </div>
    </section>
  );
});
