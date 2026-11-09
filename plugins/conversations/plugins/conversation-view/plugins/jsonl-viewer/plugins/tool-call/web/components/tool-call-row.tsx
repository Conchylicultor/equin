import { useMemo } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  useBlockWriting,
  useStreamingRow,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { JsonlViewerTool } from "../slots";
import { inputSummary, type ToolCallEvent } from "../../core";
import { ToolCallCard } from "./tool-call-card";
import { ToolFooterContext } from "../internal/footer-context";

export function ToolCallRow({ event }: { event: JsonlEvent }) {
  const e = event as ToolCallEvent;
  const streaming = useStreamingRow();
  const writing = useBlockWriting();
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
    // A stand-in: the transcript does not hold the call yet (it lands with its
    // result). While the model still writes it, only a renderer that draws a
    // partial input gets it — any other would meet fields that are not there
    // yet — and the rest show the bare card, its summary read from what is
    // written so far. Once written, the input is whole: its own renderer draws
    // it while it runs. The footer is what the call left behind; nothing has.
    return writing && !match({ event: e })?.partialInput ? (
      <ToolCallCard event={e} summary={inputSummary(e.input)} />
    ) : (
      <JsonlViewerTool.Renderer.Dispatch event={e} />
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
