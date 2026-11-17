import type { ReactNode } from "react";
import { KeepScope } from "@plugins/primitives/plugins/kept-state/web";
import { PaneInstanceContext, paneKeepSegment } from "../pane";

/**
 * Where one pane instance renders: the instance context every pane hook reads
 * (`useCurrentPane`, `useClose`, …) and the `KeepScope` its view state is kept
 * under (the instance's uuid — the same pane instance after a reload). A
 * layout renderer wraps each instance it draws in one.
 */
export function PaneInstance({
  entry,
  children,
}: {
  entry: { instanceId: number; uuid: string };
  children: ReactNode;
}) {
  return (
    <PaneInstanceContext.Provider value={entry.instanceId}>
      <KeepScope segment={paneKeepSegment(entry.uuid)}>{children}</KeepScope>
    </PaneInstanceContext.Provider>
  );
}
