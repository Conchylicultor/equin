import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { useStreamingRow } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { JsonlViewerTool } from "../slots";
import type { ToolCallEvent } from "../../core";
import { ToolCallCard } from "./tool-call-card";

export function ToolCallRow({ event }: { event: JsonlEvent }) {
  const e = event as ToolCallEvent;
  const streaming = useStreamingRow();
  const match = JsonlViewerTool.Renderer.useMatch();
  if (streaming) {
    // The model is still writing the call: only a renderer that draws a
    // partial input gets it; any other would meet fields that are not there
    // yet. Nothing has run, so there is no footer.
    return match({ event: e })?.partialInput ? (
      <JsonlViewerTool.Renderer.Dispatch event={e} />
    ) : (
      <ToolCallCard event={e} />
    );
  }
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
