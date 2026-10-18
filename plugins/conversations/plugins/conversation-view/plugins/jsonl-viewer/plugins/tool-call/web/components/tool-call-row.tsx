import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { JsonlViewerTool } from "../slots";
import type { ToolCallEvent } from "../../core";

export function ToolCallRow({ event }: { event: JsonlEvent }) {
  const e = event as ToolCallEvent;
  // The footer sits under whichever renderer drew the card; a contribution
  // that is not about this call renders nothing, so it adds no box (and no
  // gap) — its own spacing is its own.
  return (
    <>
      <JsonlViewerTool.Renderer.Dispatch event={e} />
      <JsonlViewerTool.Footer.Render>
        {(item) => <item.component event={e} />}
      </JsonlViewerTool.Footer.Render>
    </>
  );
}
