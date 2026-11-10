import { useEffect, type RefObject } from "react";
import {
  assertViewportEscape,
  type ViewportEscapeOptions,
} from "./viewport-escape";

/**
 * Run `fn` once the frame being committed has been rendered: a `requestAnimationFrame`
 * (just before that frame's style/layout/paint) and then a fresh task, which the
 * browser schedules after the paint. By then the document's style is clean, so a
 * `getComputedStyle` read costs a lookup instead of forcing a synchronous
 * full-document style recalc. Returns the cancel.
 */
function afterNextPaint(fn: () => void): () => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const frame = requestAnimationFrame(() => {
    timeout = setTimeout(fn, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (timeout !== undefined) clearTimeout(timeout);
  };
}

/**
 * The React seam over {@link assertViewportEscape}: audit the ancestor chain of
 * a ref'd element once a viewport-relative box starts mattering.
 *
 * AFTER THE PAINT, not in a layout effect. The walk reads computed style up to
 * `<html>`; run in the commit that switched the box on (a fullscreen switch
 * re-styles the whole document), every read forced a synchronous recalc of the
 * whole dirty document — 561 ms of a fullscreen switch on an ~18k-element page.
 * The audit is an invariant check, not functionality, so it waits for the frame
 * to be rendered and reads clean style. It still fails loudly: in dev the throw
 * is an uncaught error one frame later (the reports pipeline files it), in prod
 * the report sink fires as before. What it gives up is the throw arriving
 * *instead of* the first wrong-looking frame.
 *
 * `enabled` is the activation — pass the same condition that turns the
 * viewport-relative box on (`viewportRelative`, `import.meta.env.DEV`). A false
 * `enabled`, or a ref that is not attached when the audit runs, is a silent
 * no-op; there is deliberately no non-null assertion at the call site, because
 * "the element is not there" is a legitimate state and not a fault to report.
 * Deactivating (or unmounting) before the audit ran cancels it.
 *
 * The deps are the ACTIVATION, not the render. Re-walking the chain on every
 * render would re-throw the same fault every frame (and in prod re-emit the same
 * report), so the effect re-runs only when what it is auditing changes: the
 * enablement, and the caller's wording. Those are string literals at every call
 * site, so in practice this runs once per activation.
 */
export function useViewportEscape(
  ref: RefObject<Element | null>,
  options: ViewportEscapeOptions & { enabled?: boolean },
): void {
  const { subject, remedy, from, enabled = true } = options;
  useEffect(() => {
    if (!enabled) return;
    return afterNextPaint(() => {
      const el = ref.current;
      if (!el) return;
      assertViewportEscape(el, { subject, remedy, from });
    });
  }, [ref, subject, remedy, from, enabled]);
}
