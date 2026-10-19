import type { ReactNode } from "react";
import { embedUrl } from "@plugins/primitives/plugins/embed/web";
import {
  FrameSource,
  type CanvasFrame,
  type FrameResolution,
  type PrototypeFrame,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import type {
  PrototypeMeta,
  PrototypeViewport,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { presentPath } from "../internal/routes";

/** What a prototype frame's page shows: its version, and its own picks (not A's). */
function frameTarget(frame: PrototypeFrame, meta: PrototypeMeta) {
  return {
    name: meta.name,
    sha: frame.version?.sha,
    // Frame A reads the shared record, and so will the page; any other frame
    // carries its own variant along.
    picks: frame.picks === "shared" ? undefined : frame.picks,
  };
}

/**
 * Where a frame opens in a new browser tab, handed to `children` as an href —
 * `undefined` when it cannot. A prototype frame opens its present page chromeless, at
 * `size` (the size it declares when omitted); a source frame opens its own
 * `href`, which is already the page at the tab's size, whatever `size` says.
 */
export function BrowserTabOpener({
  frame,
  meta,
  size,
  children,
}: {
  frame: CanvasFrame;
  meta: PrototypeMeta;
  size?: PrototypeViewport;
  children: (href: string | undefined) => ReactNode;
}) {
  if (frame.kind === "prototype") {
    return children(
      embedUrl(
        presentPath({
          ...frameTarget(frame, meta),
          ...(size === undefined ? {} : { size }),
        }),
        "chromeless",
      ),
    );
  }
  return (
    <FrameSource.Dispatch source={frame.source} meta={meta}>
      {(resolution: FrameResolution) =>
        children(
          resolution.status === "found" && resolution.href !== undefined
            ? resolution.href
            : undefined,
        )
      }
    </FrameSource.Dispatch>
  );
}
