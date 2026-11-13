import { useRef, type CSSProperties, type ReactNode } from "react";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Stack,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import type { RenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import { useSuppressToasts } from "@plugins/shell/plugins/toast/web";
import type { CompanionSectionProps } from "../slots";
import { StatusLineProvider } from "../internal/status-line";

/**
 * A companion's whole page: the panel filling its window (`Clip` → `Surface
 * level="overlay"` → `Scroll` → a stack of sections). Its body is the host's
 * own section slot (`sections`, e.g. `MenuBar.Section`) and nothing else: the
 * panel names no section, and each companion orders its own in that slot's
 * reorder config.
 *
 * It shows no toasts (the app-wide stack does not belong in a menu: sections
 * say their outcomes inline). What only a host can do comes in as props:
 *
 * - `style` — on the panel's clip (a transparent native window's corners);
 * - `onContentHeight` — the sections' natural height, pushed by a
 *   ResizeObserver as sections load, grow or appear, so the host's window
 *   fits them;
 * - `onAttention` — whether the status line needs the user (an icon's dot, a
 *   badge);
 * - `children` — headless extras that live as long as the panel (a host's
 *   mount slot, a self-reload), inside the status line's provider.
 */
export function CompanionPanel({
  sections,
  style,
  onContentHeight = null,
  onAttention = null,
  children,
}: {
  sections: RenderSlot<CompanionSectionProps>;
  style?: CSSProperties;
  onContentHeight?: ((px: number) => void) | null;
  onAttention?: ((on: boolean) => void) | null;
  children?: ReactNode;
}) {
  useSuppressToasts();
  return (
    <Clip fill style={style}>
      <Surface
        level="overlay"
        // The host's window IS the panel: it owns the shadow.
        className="size-full rounded-none shadow-none ring-0"
      >
        <StatusLineProvider onAttention={onAttention}>
          <Scroll className="h-full">
            <PanelSections
              sections={sections}
              onContentHeight={onContentHeight}
            />
          </Scroll>
          {children}
        </StatusLineProvider>
      </Surface>
    </Clip>
  );
}

/** The sections, natural height, reported to the host so its window fits. */
function PanelSections({
  sections,
  onContentHeight,
}: {
  sections: RenderSlot<CompanionSectionProps>;
  onContentHeight: ((px: number) => void) | null;
}) {
  const content = useRef<HTMLElement>(null);
  useResizeObserver(
    content,
    () => {
      const el = content.current;
      if (onContentHeight === null || el === null) return;
      onContentHeight(Math.ceil(el.getBoundingClientRect().height));
    },
    { deps: [onContentHeight] },
  );
  const Sections = sections.Render;
  return (
    <Stack ref={content} gap="none" className={insetClass({ pad: "sm" })}>
      <Sections />
    </Stack>
  );
}
