import { useLayoutEffect, useRef, useState } from "react";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useTabDragSession } from "../hooks/use-tab-drag";
import { WindowAppTile } from "./window-app-tile";

/**
 * The mockup's tab-drag looks (`.tab-ghost`, `.tabs.drop-target`, `.tab-mark`,
 * `.tear-preview`): fixed pixel chrome, its shadows and accent-on-glass mixes
 * literal because no theme token expresses them.
 */
const GHOST_STYLE = {
  height: 28,
  padding: "0 12px",
  borderRadius: 7,
  gap: 7,
  maxWidth: 220,
  transform: "translate(-50%, -50%) rotate(-1.5deg)",
  boxShadow:
    "0 0 0 0.5px oklch(0.2 0.02 265 / 14%), 0 10px 24px -6px rgba(0, 0, 0, 0.35)",
} as const;
const DROP_TARGET_STYLE = {
  borderRadius: 8,
  boxShadow:
    "inset 0 0 0 1.5px color-mix(in oklab, var(--primary) 55%, transparent)",
  background: "color-mix(in oklab, var(--primary) 6%, transparent)",
} as const;
const MARK_STYLE = {
  width: 2,
  height: 22,
  borderRadius: 1,
  transform: "translateX(-1px)",
} as const;
const TEAR_STYLE = {
  borderRadius: 12,
  border: "1.5px dashed color-mix(in oklab, var(--primary) 70%, white)",
  background:
    "color-mix(in oklab, var(--primary) 10%, rgba(255, 255, 255, 0.12))",
} as const;
const TEAR_PILL_STYLE = {
  padding: "4px 10px",
  background: "rgba(20, 22, 28, 0.6)",
} as const;
/** Where the tear-off box sits under the pointer (mockup: 80px in, 16px down). */
const TEAR_OFFSET = { x: 80, y: 16 };

/**
 * The layout measurements the overlay paints from. Read from the live DOM in a
 * `useLayoutEffect` (after commit, before paint) rather than during render, and
 * stored in state — so the overlay renders from committed values and never reads
 * a rect during render. Re-measured on every `session` change (the drag channel
 * mints a fresh object on every pointermove), so the visuals track the pointer.
 */
interface DragMeasurements {
  /** Backdrop-origin x/y (the overlay root's own rect) to map viewport→backdrop. */
  ox: number;
  oy: number;
  /** The hovered strip's drop-zone rect, if any. */
  stripRect?: { left: number; top: number; width: number; height: number };
  /** The insertion mark: its x (a chip's edge) and top (that chip's top + 3). */
  mark?: { x: number; y: number };
}

/**
 * The live tab-chip drag visuals, rendered as part of the floating placement's
 * `Foreground` (a sibling above every window container), inside the desktop's
 * theme. Reads the transient {@link useTabDragSession} channel and paints the
 * mockup's three cues:
 *
 * - a **ghost** — the tab's app tile and title on a tilted card riding the cursor;
 * - over a window's tab strip, the strip **lit as a drop target** and an
 *   **insertion mark** at the gap the tab would land in;
 * - over the empty desktop, a **tear-off preview** — the dashed outline of the
 *   window it would become, labelled "New window".
 *
 * Everything is positioned `absolute` within the backdrop (the Foreground's
 * transformed parent breaks `position: fixed`), so viewport rects are mapped to
 * backdrop coords by subtracting the overlay root's own rect (it fills the
 * backdrop).
 */
export function TabDragOverlay() {
  const session = useTabDragSession();
  const rootRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<DragMeasurements>({ ox: 0, oy: 0 });

  // Measure after layout (committed values only — never a rect read in render).
  const drop = session?.drop ?? null;
  useLayoutEffect(() => {
    if (!session) return;
    const originRect = rootRef.current?.getBoundingClientRect();
    const ox = originRect?.left ?? 0;
    const oy = originRect?.top ?? 0;

    const stripEl =
      drop?.kind === "strip"
        ? document.querySelector<HTMLElement>(
            `[data-floating-window-id="${CSS.escape(drop.windowId)}"]`,
          )
        : null;
    const stripRect = stripEl?.getBoundingClientRect();

    // The insertion mark (mockup `startTabDrag`): at the left edge of the chip
    // the tab would land before, or past the right edge of the last chip.
    let mark: DragMeasurements["mark"];
    if (drop?.kind === "strip" && stripEl) {
      const chips = stripEl.querySelectorAll<HTMLElement>(
        "[data-floating-tab-id]",
      );
      const before = chips[drop.index];
      const ref = before ?? chips[chips.length - 1];
      if (ref) {
        const r = ref.getBoundingClientRect();
        mark = { x: before ? r.left - 1 : r.right + 1, y: r.top + 3 };
      }
    }

    setMeasured({
      ox,
      oy,
      stripRect: stripRect
        ? {
            left: stripRect.left,
            top: stripRect.top,
            width: stripRect.width,
            height: stripRect.height,
          }
        : undefined,
      mark,
    });
  }, [session, drop]);

  if (!session) return null;

  const { ox, oy, stripRect, mark } = measured;
  const onDesktop = drop?.kind === "desktop";

  return (
    <div
      ref={rootRef}
      aria-hidden
      // A genuine one-off: a full-bleed within-surface overlay anchor (like the
      // snap ghost) — Overlay would establish its own relative box, not fill the
      // backdrop; no positioning primitive models this.
      // eslint-disable-next-line layout/no-adhoc-layout -- transient drag-overlay anchor filling the backdrop; no positioning primitive applies
      className="pointer-events-none absolute inset-0 z-max"
    >
      {/* The window it would become, on the empty desktop. */}
      {onDesktop && (
        <Center
          // eslint-disable-next-line layout/no-adhoc-layout -- transient tear-off preview positioned from the live pointer; no positioning primitive applies
          className="absolute"
          style={{
            ...TEAR_STYLE,
            left: session.pointer.x - ox - TEAR_OFFSET.x,
            top: session.pointer.y - oy - TEAR_OFFSET.y,
            width: session.tearSize.w,
            height: session.tearSize.h,
          }}
        >
          <Text
            variant="label"
            className="rounded-full text-white"
            style={TEAR_PILL_STYLE}
          >
            New window
          </Text>
        </Center>
      )}

      {/* The hovered strip, lit as the drop target. */}
      {stripRect && (
        <div
          // eslint-disable-next-line layout/no-adhoc-layout -- transient drop-target highlight positioned from a measured strip rect; no positioning primitive applies
          className="absolute"
          style={{
            ...DROP_TARGET_STYLE,
            left: stripRect.left - ox,
            top: stripRect.top - oy,
            width: stripRect.width,
            height: stripRect.height,
          }}
        />
      )}

      {/* The insertion mark at the gap the tab would land in. */}
      {mark && stripRect && (
        <div
          // eslint-disable-next-line layout/no-adhoc-layout -- transient insertion mark positioned from measured chip rects; no positioning primitive applies
          className="absolute bg-primary"
          style={{ ...MARK_STYLE, left: mark.x - ox, top: mark.y - oy }}
        />
      )}

      {/* The ghost: the tab's tile and title on a tilted card under the cursor. */}
      <Line
        // eslint-disable-next-line layout/no-adhoc-layout -- transient drag ghost positioned from the live pointer; no positioning primitive applies
        className="absolute bg-card text-label text-card-foreground"
        style={{
          ...GHOST_STYLE,
          left: session.pointer.x - ox,
          top: session.pointer.y - oy,
        }}
      >
        <WindowAppTile icon={session.icon} size={16} radius={4} />
        <Text>{session.label}</Text>
      </Line>
    </div>
  );
}
