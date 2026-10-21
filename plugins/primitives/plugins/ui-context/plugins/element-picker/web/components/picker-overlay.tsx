import {
  Button,
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Placed,
  placedClasses,
  placedStyle,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { useEffect, useState } from "react";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { collectLineage } from "@plugins/primitives/plugins/ui-context/web";
import {
  formatShortcutLabel,
  isModHeld,
} from "@plugins/primitives/plugins/shortcuts/web";
import { resolveTarget } from "../internal/resolve-target";

interface Highlight {
  rect: DOMRect;
  pluginId?: string;
  tag: string;
}

export function PickerOverlay({
  onPick,
  onCancel,
  hint,
}: {
  onPick: (el: Element) => void;
  onCancel: () => void;
  /** The instruction pill at the bottom of the screen; none when omitted. */
  hint?: string;
}) {
  const [highlight, setHighlight] = useState<Highlight | null>(null);

  useEffect(() => {
    // Holding `mod` (⌘ / Ctrl) hands the pointer back to the app: a mod-click
    // is a real click, so the user can open the menu, sub-menu or popover that
    // holds what they mean, then pick inside it. The highlight drops while it is
    // held, so the screen says which of the two a click will do.
    let pointer: { x: number; y: number } | null = null;
    let passThrough = false;
    const refresh = () => {
      const el =
        pointer && !passThrough ? resolveTarget(pointer.x, pointer.y) : null;
      if (!el) {
        setHighlight(null);
        return;
      }
      const nodes = collectLineage(el);
      setHighlight({
        rect: el.getBoundingClientRect(),
        pluginId: nodes[nodes.length - 1]?.pluginId,
        tag: el.tagName.toLowerCase(),
      });
    };

    const onMove = (e: MouseEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      passThrough = isModHeld(e);
      refresh();
    };

    // Swallow the press itself (capture phase, before it reaches the document).
    // Picking is often launched from inside an open popover; without this the
    // press on the underlying app element reads as an outside-press and dismisses
    // the popover (and moves focus out of it) before the chip is injected.
    // preventDefault also keeps focus on the popover so no focus-out dismissal
    // fires. The actual pick happens on the subsequent `click`.
    //
    // A press on the overlay's OWN chrome (the hint pill's Cancel) is swallowed
    // the same way, for the same popover's sake — but only the press: its
    // `click` still reaches the button, because `resolveTarget` answers null over
    // the chrome and `onClick` below lets a null through.
    const onDown = (e: MouseEvent) => {
      if (isModHeld(e)) return;
      const el = resolveTarget(e.clientX, e.clientY);
      if (!el && !isPickerChrome(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };

    const onClick = (e: MouseEvent) => {
      if (isModHeld(e)) return;
      const el = resolveTarget(e.clientX, e.clientY);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      onPick(el);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      // Pressing or releasing `mod` without moving the pointer flips the mode
      // too; the event's own modifier state already reflects the change.
      if (isModHeld(e) !== passThrough) {
        passThrough = isModHeld(e);
        refresh();
      }
    };

    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onClick, true);
    // eslint-disable-next-line shortcuts/no-window-key-listener -- pick mode is page-wide by design (it overlays every surface) and listens only while picking; Escape cancels it.
    window.addEventListener("keydown", onKey, true);
    // eslint-disable-next-line shortcuts/no-window-key-listener -- same page-wide pick mode: releasing mod (⌘ / Ctrl) hands clicks back to the picker.
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [onPick, onCancel]);

  return (
    // pointer-events:none so document.elementFromPoint returns the underlying
    // app element rather than this overlay.
    <ViewportOverlay
      layer="max"
      data-element-picker
      className="pointer-events-none"
    >
      {highlight && (
        <>
          <Placed
            decorative
            x={{ start: highlight.rect.left, size: highlight.rect.width }}
            y={{ start: highlight.rect.top, size: highlight.rect.height }}
            className="bg-primary/10 border-primary border-2"
          />
          {/* The label is an `Inset`, so the placement arrives as the class +
              style helpers rather than a wrapper. */}
          <Inset
            x="2xs"
            y="none"
            className={cn(
              placedClasses({ decorative: true }),
              "bg-primary text-primary-foreground rounded-sm text-caption whitespace-nowrap",
            )}
            style={placedStyle(
              { start: highlight.rect.left },
              { start: Math.max(0, highlight.rect.top - 22) },
            )}
          >
            {highlight.pluginId ? `${highlight.pluginId} · ` : ""}
            {highlight.tag}
          </Inset>
        </>
      )}

      {hint !== undefined && (
        // The one hit-testable part of the overlay, so its Cancel is clickable.
        // Still inside the chrome attribute, so a pointer over it resolves no
        // target — hovering the pill clears the highlight rather than picking
        // what is under it.
        <Pin to="bottom" offset="lg" className="pointer-events-auto">
          <Inset
            x="sm"
            y="2xs"
            className="bg-background/95 border-border text-foreground rounded-md border text-label shadow-lg backdrop-blur"
          >
            <ControlSizeProvider size="sm">
              <Stack direction="row" gap="sm" align="center">
                <span>{hint}</span>
                <Kbd>{formatShortcutLabel("mod")} click</Kbd>
                <span className="text-muted-foreground">to use the app</span>
                <Kbd>Esc</Kbd>
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              </Stack>
            </ControlSizeProvider>
          </Inset>
        </Pin>
      )}
    </ViewportOverlay>
  );
}

function isPickerChrome(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("[data-element-picker]") !== null
  );
}
