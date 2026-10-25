import { useMemo } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { useStreamingRow } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { JsonlViewerTool } from "../slots";
import type { ToolCallEvent } from "../../core";
import { ToolCallCard } from "./tool-call-card";
import { ToolFooterContext } from "../internal/footer-context";

export function ToolCallRow({ event }: { event: JsonlEvent }) {
  const e = event as ToolCallEvent;
  const streaming = useStreamingRow();
  const match = JsonlViewerTool.Renderer.useMatch();
  const footer = useMemo(
    () => ({
      toolUseId: e.toolUseId,
      footer: (
        <JsonlViewerTool.Footer.Render>
          {(item) => <item.component event={e} />}
        </JsonlViewerTool.Footer.Render>
      ),
    }),
    [e],
  );
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
  // The footer is drawn inside whichever renderer's card — `ToolCallCard`
  // takes it from context; a contribution that is not about this call
  // renders nothing, so it adds no box (and no gap) — its own spacing is its own.
  return (
    <ToolFooterContext value={footer}>
      <JsonlViewerTool.Renderer.Dispatch event={e} />
    </ToolFooterContext>
  );
}
