import { useContext, useEffect, useState, type ReactNode } from "react";
import { KeepScope } from "@plugins/primitives/plugins/kept-state/web";
import { HoldLazyMount } from "@plugins/primitives/plugins/lazy-component/web";
import {
  PaneInstanceContext,
  paneKeepSegment,
  SurfaceDrawnContext,
} from "../pane";

/**
 * Where one pane instance renders: the instance context every pane hook reads
 * (`useCurrentPane`, `useClose`, …) and the `KeepScope` its view state is kept
 * under (the instance's uuid — the same pane instance after a reload). A
 * layout renderer wraps each instance it draws in one.
 *
 * A pane mounted by a navigation (the surface already on screen) holds its
 * lazy components while it first mounts (`HoldLazyMount`): one whose code is
 * not in yet suspends the surface's deferred render, so the previous screen
 * stays until this pane can draw. Once mounted, a lazy component it opens
 * later draws its own loading state.
 */
export function PaneInstance({
  entry,
  children,
}: {
  entry: { instanceId: number; uuid: string };
  children: ReactNode;
}) {
  const surfaceDrawn = useContext(SurfaceDrawnContext);
  const [mounting, setMounting] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a commit fact: the pane's first mount is over once it committed, and only that mount is held (see the doc above).
    setMounting(false);
  }, []);
  return (
    <PaneInstanceContext.Provider value={entry.instanceId}>
      <HoldLazyMount active={surfaceDrawn && mounting}>
        <KeepScope segment={paneKeepSegment(entry.uuid)}>{children}</KeepScope>
      </HoldLazyMount>
    </PaneInstanceContext.Provider>
  );
}
