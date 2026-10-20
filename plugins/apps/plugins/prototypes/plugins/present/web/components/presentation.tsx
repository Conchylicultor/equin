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
import { PresentOverlay } from "./present-overlay";

interface Presenting {
  frameId: FrameId;
  /** Bumped by every `present`, so each one mounts a fresh overlay. */
  n: number;
}

interface PresentationValue {
  /** What is presented, or `null`. */
  presenting: Presenting | null;
  present: (frameId: FrameId) => void;
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
 * `PrototypeDetailWrap`, so it sits above every frame. A frame's Full screen
 * button only asks for it: the button lives in its frame's header, which a layout
 * change remounts (`+` leaving Swipe, Compare entering it), and that must not
 * close the presentation that made the change.
 *
 * Each `present` remounts the overlay (keyed by `n`), so each one requests
 * full screen afresh.
 */
export function PresentationHost({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const { name } = usePrototypeDetail();
  const [presenting, setPresenting] = useState<Presenting | null>(null);
  const present = useCallback(
    (frameId: FrameId) =>
      setPresenting((prev) => ({ frameId, n: (prev?.n ?? 0) + 1 })),
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
          onClose={close}
        />
      ) : null}
    </PresentationContext.Provider>
  );
}
