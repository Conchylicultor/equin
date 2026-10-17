import { useEffect, useMemo, useRef } from "react";
import type React from "react";

import { ControlPanelSection } from "./control-panel";
import { ControlPanelRow } from "./control-panel-row";
import {
  PanelStackContext,
  usePanelStackState,
  type PanelStackApi,
  type PanelStackState,
} from "./stack-context";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const arrowBackIcon = symbol("arrow-back");

export interface ControlPanelStackProps {
  /** The depth-0 panel. */
  root: React.ReactNode;
  /**
   * Called when Escape is pressed at depth 0 — the level the stack cannot pop.
   * The key event is NOT swallowed there, so a host popover still closes on it;
   * this is for a host that needs to know as well.
   */
  onExhausted?: () => void;
  /**
   * State owned by the host, for a host that reads the showing page from
   * outside (see `PanelStackState`). Omitted: the stack owns its own.
   */
  state?: PanelStackState;
  // No `className`: the stack's element is `display: contents` (below), a box the
  // layout does not generate, so a class here could not size, space or paint
  // anything a caller would expect it to.
}

/**
 * Panel navigation: a stack of panels rendered one at a time, with a back header
 * built out of the vocabulary itself rather than out of bespoke chrome.
 *
 * It lives in the primitive, not in any one consumer, because three independent
 * surfaces need it — the compact toolbar fold, the filter builder's nested
 * groups, and custom-columns' per-field editor.
 *
 * Pushing beats opening a popover from inside a popover, which is what these
 * surfaces do today: a nested group grows the panel horizontally past the pane,
 * and a second floating layer has its own width, its own clamp and its own
 * dismissal. A pushed panel is the same box, the same width and the same rails
 * at every depth.
 */
export function ControlPanelStack({
  root,
  onExhausted,
  state,
}: ControlPanelStackProps) {
  const own = usePanelStackState();
  const { entries: stack, push, pop, close, reset } = state ?? own;
  const containerRef = useRef<HTMLDivElement>(null);

  const depth = stack.length;
  const api = useMemo<PanelStackApi>(
    () => ({ depth, push, pop, close, reset }),
    [depth, push, pop, close, reset],
  );

  // Escape pops one level and stops there; at depth 0 it falls through so the
  // host popover closes on the same key. The listener is NATIVE and on the
  // container, not a React `onKeyDown`: the dismissal handlers it has to beat
  // are registered on the document, and only stopping the real event as it
  // bubbles past this element reliably gets in front of them.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (depth === 0) {
        onExhausted?.();
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      pop();
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [depth, onExhausted, pop]);

  // On push, focus moves into the panel that just appeared — otherwise focus
  // stays on the row that pushed it, which has just been hidden, and the keyboard
  // user lands back at the document body. Only on the way DOWN: popping should
  // leave focus where the back button was.
  const prevDepth = useRef(depth);
  useEffect(() => {
    const grew = depth > prevDepth.current;
    prevDepth.current = depth;
    if (!grew) return;
    // Scoped to the SHOWING level: the levels below it are still mounted (see
    // the render), and their first button comes first in document order.
    const first = containerRef.current?.querySelector<HTMLElement>(
      `[data-cp-level="${depth}"] :is(` +
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])' +
        ")",
    );
    first?.focus();
  }, [depth]);

  const top = stack.at(-1);

  // EVERY LEVEL STAYS MOUNTED; only the top one is shown. A pushed page is
  // usually a live view of something its pusher owns — a `Group`'s fields, which
  // it portals into its level — and that only works while the pusher is still
  // rendered. Unmounting the levels below (what this used to do) froze a pushed
  // page at the props it was pushed with: an edit there wrote through a closure
  // over the value as it was at push time, so the NEXT edit silently reverted
  // the one before it, and removing the item it was about left its page on screen.
  const level = (index: number, content: React.ReactNode, key: string) => (
    <div
      key={key}
      data-cp-level={index}
      // The surface reads its width from the SHOWING page's content only
      // (`[data-cp-surface]` in `app.css`): a level below, hidden but still
      // mounted, must not keep the panel builder-wide.
      data-cp-showing={index === depth ? "" : undefined}
      style={{ display: index === depth ? "contents" : "none" }}
    >
      {content}
    </div>
  );

  return (
    <PanelStackContext value={api}>
      {/* LAYOUT-TRANSPARENT on purpose. This div exists only to hold the keydown
          listener and the focus query — it is not a box in the panel, and it must
          not be one: `display: contents` generates no box, so the bands inside it
          are laid out by the enclosing `ControlPanel`'s own `cp-body` flex
          container, which is then the ONE box spacing bands and the ONE box
          cancelling the first band's rule.
          It used to carry `cp-body` itself, to re-create a `& > * + *` sibling
          rule the panel could not reach through it. That was a workaround for
          exactly one level of wrapping, and it silently stopped working at two
          (the framework's own `renderIsolated` lineage span is the next one down)
          — which is why the rule now belongs to the bands. Events and refs are
          unaffected by `display: contents`: the element is still in the DOM and
          still on the event path. */}
      <div ref={containerRef} style={{ display: "contents" }}>
        {top ? (
          <ControlPanelSection>
            <ControlPanelRow
              icon={<Icon icon={arrowBackIcon} />}
              onSelect={pop}
            >
              {top.title}
            </ControlPanelRow>
          </ControlPanelSection>
        ) : null}
        {level(0, root, "root")}
        {stack.map((entry, index) =>
          level(index + 1, entry.render(), entry.key),
        )}
      </div>
    </PanelStackContext>
  );
}
