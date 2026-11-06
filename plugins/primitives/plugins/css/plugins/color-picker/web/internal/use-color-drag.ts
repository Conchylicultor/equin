import { useCallback } from "react";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

/**
 * Pointer drag over `elRef`, reported as fractions (0..1) of its box. `onEnd`
 * fires once when the pointer is released or the drag is cancelled — the
 * moment a drag becomes a committed value.
 */
export function useColorDrag(
  elRef: React.RefObject<HTMLElement | null>,
  onChange: (x: number, y: number) => void,
  onEnd?: () => void,
): { onPointerDown: React.PointerEventHandler } {
  const cbRef = useLatestRef(onChange);
  const endRef = useLatestRef(onEnd);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const el = elRef.current;
      if (!el) return;
      e.preventDefault();
      // preventDefault keeps the drag from selecting text, and with it the
      // focus a click would give: take it, so arrows continue the gesture.
      focusElement(el, { reveal: false });
      el.setPointerCapture(e.pointerId);

      const emit = (ev: { clientX: number; clientY: number }) => {
        const rect = el.getBoundingClientRect();
        const x = Math.max(
          0,
          Math.min(1, (ev.clientX - rect.left) / rect.width),
        );
        const y = Math.max(
          0,
          Math.min(1, (ev.clientY - rect.top) / rect.height),
        );
        cbRef.current(x, y);
      };

      emit(e);

      const onMove = (ev: PointerEvent) => emit(ev);
      const onUp = () => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        endRef.current?.();
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    },
    // `onPointerDown` stays stable and reads the freshest `onChange` / `onEnd`
    // off the stable refs at emit time.
    [elRef],
  );

  return { onPointerDown };
}
