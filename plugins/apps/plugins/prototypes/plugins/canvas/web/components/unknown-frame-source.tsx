import type { ReactElement, ReactNode } from "react";
import { useDeferredLoadComplete } from "@plugins/framework/plugins/web-sdk/core";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";

/**
 * The frame-source dispatch fallback: a frame names a source nothing contributes.
 * Until the deferred plugin tier has loaded that is not known yet — a reopened
 * canvas names its Real app frame before compare's plugin registers — so it
 * reads `loading`. After, the plugin is really gone (removed, or not in this
 * worktree) and the frame says so. Rendered through
 * the same `children(resolution)` path as a real source, so the frame's chrome
 * is the same — only the sentence differs.
 *
 * Its props are spelled out rather than imported from `slots.ts`, which imports
 * this file: the reverse import would be a cycle.
 */
export function UnknownFrameSource({
  source,
  children,
}: {
  source: string;
  meta: PrototypeMeta;
  children: (
    resolution:
      | { status: "loading" }
      | { status: "unresolved"; title: ReactNode; detail: ReactNode },
  ) => ReactNode;
}): ReactElement {
  const deferredComplete = useDeferredLoadComplete();
  if (!deferredComplete) return <>{children({ status: "loading" })}</>;
  return (
    <>
      {children({
        status: "unresolved",
        title: `Nothing in this worktree shows “${source}” frames.`,
        detail:
          "The plugin that added this frame is not loaded here. Close the frame.",
      })}
    </>
  );
}
