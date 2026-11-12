import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import {
  ToolCallCard,
  ToolOutput,
  ToolSection,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { HighlightedCode } from "@plugins/primitives/plugins/syntax-highlight/web";
import { describeBrowserCall } from "../internal/describe";

/**
 * Every browser_* call: the salient input as the header, the call's code (or
 * its action list) and the result text folded beneath. A screenshot's image is
 * not part of the transcript event (its result is text); the browser-recording
 * footer draws the frame under this card.
 */
export function BrowserToolView({ event }: ToolRendererProps) {
  const view = describeBrowserCall(event.name, event.input);
  const result = event.result;
  const failed = result?.isError === true;

  return (
    <ToolCallCard
      event={event}
      summary={<span className="font-mono">{view.summary}</span>}
      defaultOpen={failed}
    >
      {view.body && (
        <ToolSection label="Input" copyText={view.body.code}>
          <HighlightedCode code={view.body.code} lang={view.body.lang} />
        </ToolSection>
      )}
      {result && result.content !== "" && <ToolOutput event={event} />}
    </ToolCallCard>
  );
}
