import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
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
import { ViewportOverlay } from "@plugins/primitives/plugins/css/plugins/viewport-overlay/web";
import {
  uiContextLabel,
  type UiContextLabel,
} from "@plugins/primitives/plugins/ui-context/core";
import { collectMeta } from "@plugins/primitives/plugins/ui-context/web";
import { ForAudience } from "@plugins/audience/plugins/developer-mark/web";
import { isModHeld } from "@plugins/primitives/plugins/shortcuts/web";
import { PickerLayer } from "../internal/layer";
import { resolveTarget } from "../internal/resolve-target";

interface Highlight {
  rect: DOMRect;
  /** What the chip will call the element once picked — the same words, so the
   *  hover previews the pick rather than describing its markup. */
  label: UiContextLabel;
  /** The innermost plugin owning the element: shown to a developer only. */
  pluginId?: string;
}

/** The label half of a highlight, read once per hovered element (`collectMeta`
 *  walks the lineage and the owner chain — a mousemove inside the same element
 *  only moves the box). */
interface Described {
  el: Element;
  label: UiContextLabel;
  pluginId?: string;
}

function describe(el: Element): Described {
  const meta = collectMeta(el);
  return { el, label: uiContextLabel(meta), pluginId: meta.pluginId };
}

export function PickerOverlay({
  onPick,
  onCancel,
}: {
  onPick: (el: Element) => void;
  onCancel: () => void;
}) {
  const [highlight, setHighlight] = useState<Highlight | null>(null);

  useEffect(() => {
    // Holding `mod` (⌘ / Ctrl) hands the pointer back to the app: a mod-click
    // is a real click, so the user can open the menu, sub-menu or popover that
    // holds what they mean, then pick inside it. The highlight drops while it is
    // held, so the screen says which of the two a click will do.
    let pointer: { x: number; y: number } | null = null;
    let passThrough = false;
    let described: Described | null = null;
    const refresh = () => {
      const el =
        pointer && !passThrough ? resolveTarget(pointer.x, pointer.y) : null;
      if (!el) {
        setHighlight(null);
        return;
      }
      if (described?.el !== el) described = describe(el);
      setHighlight({
        rect: el.getBoundingClientRect(),
        label: described.label,
        pluginId: described.pluginId,
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
    const onDown = (e: MouseEvent) => {
      if (isModHeld(e)) return;
      const el = resolveTarget(e.clientX, e.clientY);
      if (!el) return;
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
      layer={PickerLayer}
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
          {/* What a person calls the element, as its chip will once picked;
              the owning plugin id beside it is developer text, so only a
              developer sees it — marked as such. */}
          <Stack
            direction="row"
            gap="2xs"
            align="center"
            className={cn(
              placedClasses({ decorative: true }),
              "text-caption whitespace-nowrap",
            )}
            style={placedStyle(
              { start: highlight.rect.left },
              { start: Math.max(0, highlight.rect.top - 22) },
            )}
          >
            <Inset
              x="2xs"
              y="none"
              className="bg-primary text-primary-foreground rounded-sm"
            >
              {highlight.label.title}
              {highlight.label.kind ? ` · ${highlight.label.kind}` : ""}
            </Inset>
            {highlight.pluginId && (
              <ForAudience audience="developer" mark="inline">
                <Inset
                  x="2xs"
                  y="none"
                  className="bg-popover text-muted-foreground rounded-sm border"
                >
                  {highlight.pluginId}
                </Inset>
              </ForAudience>
            )}
          </Stack>
        </>
      )}
    </ViewportOverlay>
  );
}
