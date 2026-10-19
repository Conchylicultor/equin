import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { hoverRevealGroup } from "@plugins/primitives/plugins/hover-reveal/web";
import { PortalHost } from "@plugins/primitives/plugins/overlay/plugins/portal-host/web";
import { PopupOpenScope } from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import { usePointerIdle } from "../internal/use-pointer-idle";

const ChromeIdleContext = createContext(false);
const PresentRootContext = createContext<HTMLElement | null>(null);

/** Whether the presentation's chrome is resting out of sight (see `PresentBox`). */
export function useChromeIdle(): boolean {
  return useContext(ChromeIdleContext);
}

/**
 * The presentation's box — what the chrome is dragged around inside (`null`
 * until it mounts).
 */
export function usePresentRoot(): HTMLElement | null {
  return useContext(PresentRootContext);
}

/**
 * The box every presentation draws its stage in — the in-app overlays and the
 * new-tab page alike: the positioning context the chrome pins to, the hover
 * anchor that reveals it, and a `PortalHost` so every popup opened inside
 * (the version list, the size menu, a tooltip) is drawn inside the box — under
 * the Fullscreen API only this subtree is painted, and a viewport presentation
 * sits above the popup layer.
 *
 * Hovering reveals the chrome; resting the pointer over the frame hides it
 * again (`usePointerIdle`), so what the chrome covers can be seen — unless a
 * popup opened from it is still showing.
 */
export function PresentBox({
  boxRef,
  children,
}: {
  /** The box element, for a caller that needs it too (the Fullscreen API). */
  boxRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}): ReactElement {
  return (
    <PopupOpenScope>
      {(popupOpen) => (
        <IdleBox boxRef={boxRef} hold={popupOpen}>
          {children}
        </IdleBox>
      )}
    </PopupOpenScope>
  );
}

function IdleBox({
  boxRef,
  hold,
  children,
}: {
  boxRef: RefObject<HTMLDivElement | null> | undefined;
  hold: boolean;
  children: ReactNode;
}): ReactElement {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const idle = usePointerIdle(root, hold);
  // Stable, so the box is attached once rather than detached and re-attached
  // on every render.
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      setRoot(el);
      if (boxRef) boxRef.current = el;
    },
    [boxRef],
  );
  return (
    <div
      ref={attach}
      className={cn(
        "relative size-full bg-background",
        hoverRevealGroup,
        // Over our own document; the frame's document keeps its own cursor.
        idle && "cursor-none",
      )}
    >
      <PresentRootContext.Provider value={root}>
        <ChromeIdleContext.Provider value={idle}>
          <PortalHost>{children}</PortalHost>
        </ChromeIdleContext.Provider>
      </PresentRootContext.Provider>
    </div>
  );
}
