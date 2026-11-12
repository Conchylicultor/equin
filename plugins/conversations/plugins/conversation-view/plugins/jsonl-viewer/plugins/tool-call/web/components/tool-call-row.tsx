import { useMemo } from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { useStreamingRow } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { JsonlViewerToolSlots } from "../slots";
import type { ToolCallEvent } from "../../core";
import { ToolFooterContext } from "../internal/footer-context";

export function ToolCallRow({ event }: { event: JsonlEvent }) {
  const e = event as ToolCallEvent;
  const streaming = useStreamingRow();
  const footer = useMemo(
    () => ({
      toolUseId: e.toolUseId,
      footer: (
        <JsonlViewerToolSlots.Footer.Render>
          {(item) => <item.component event={e} />}
        </JsonlViewerToolSlots.Footer.Render>
      ),
    }),
    [e],
  );
  // A stand-in: the transcript does not hold the call yet (it lands with its
  // result). Its renderer reads what is written so far (`parsedToolView`):
  // a partial input while the model writes it, the whole input once written.
  // The footer is what the call left behind; nothing has yet.
  if (streaming) return <JsonlViewerToolSlots.Renderer.Dispatch event={e} />;
  // The footer is drawn inside whichever renderer's card — `ToolCallCard`
  // takes it from context; a contribution that is not about this call
  // renders nothing, so it adds no box (and no gap) — its own spacing is its own.
  return (
    <ToolFooterContext value={footer}>
      <JsonlViewerToolSlots.Renderer.Dispatch event={e} />
    </ToolFooterContext>
  );
}
