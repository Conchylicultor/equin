import type { ReactNode } from "react";
import { embedUrl } from "@plugins/primitives/plugins/embed/web";
import {
  FrameSource,
  type CanvasFrame,
  type FrameResolution,
  type PrototypeFrame,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
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
 * `undefined` when it cannot. A prototype frame opens its present page
 * chromeless at the Responsive size, so it fills the tab at the tab's own
 * width; a source frame opens its own `href`, which already is that.
 */
export function BrowserTabOpener({
  frame,
  meta,
  children,
}: {
  frame: CanvasFrame;
  meta: PrototypeMeta;
  children: (href: string | undefined) => ReactNode;
}) {
  if (frame.kind === "prototype") {
    return children(
      embedUrl(
        presentPath({
          ...frameTarget(frame, meta),
          size: { kind: "responsive" },
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
