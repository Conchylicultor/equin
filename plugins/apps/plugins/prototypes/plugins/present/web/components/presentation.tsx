import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  usePrototypeDetail,
  type FrameId,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { PresentOverlay, type PresentPlacement } from "./present-overlay";

interface Presenting {
  frameId: FrameId;
  placement: PresentPlacement;
  /** Bumped by every `present`, so each one mounts a fresh overlay. */
  n: number;
}

interface PresentationValue {
  /** What is presented, or `null`. */
  presenting: Presenting | null;
  present: (frameId: FrameId, placement: PresentPlacement) => void;
}

const PresentationContext = createContext<PresentationValue | null>(null);

/** The canvas's open presentation, and the one way to open one. */
export function usePresentation(): PresentationValue {
  const ctx = useContext(PresentationContext);
  if (!ctx) {
    throw new Error("usePresentation must be used within a PresentationHost");
  }
  return ctx;
}

/**
 * Holds the canvas's one open presentation and draws its overlay — a
 * `PrototypeDetailWrap`, so it sits above every frame. A frame's Present menu
 * only asks for it: the menu lives in its frame's header, which a layout
 * change remounts (`+` leaving Swipe, Compare entering it), and that must not
 * close the presentation that made the change.
 *
 * Each `present` remounts the overlay (keyed by `n`): a new destination is an
 * explicit remount rather than a portal-container swap React would reconcile
 * into a half-move.
 */
export function PresentationHost({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const { name } = usePrototypeDetail();
  const [presenting, setPresenting] = useState<Presenting | null>(null);
  const present = useCallback(
    (frameId: FrameId, placement: PresentPlacement) =>
      setPresenting((prev) => ({ frameId, placement, n: (prev?.n ?? 0) + 1 })),
    [],
  );
  // Stable: the overlay's fullscreen effect keys on it.
  const close = useCallback(() => setPresenting(null), []);
  const value = useMemo(() => ({ presenting, present }), [presenting, present]);
  return (
    <PresentationContext.Provider value={value}>
      {children}
      {presenting !== null ? (
        <PresentOverlay
          key={presenting.n}
          name={name}
          frameId={presenting.frameId}
          placement={presenting.placement}
          onClose={close}
        />
      ) : null}
    </PresentationContext.Provider>
  );
}
