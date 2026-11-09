import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
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
      <ContentScope>
        <Stack gap="sm">
          {view.body && (
            <HighlightedCode code={view.body.code} lang={view.body.lang} />
          )}
          {result && result.content !== "" && (
            <Clip className="rounded-md border border-border/40 bg-muted font-mono">
              <Text as="div" variant="caption">
                <Scroll
                  as="pre"
                  className={`max-h-72 whitespace-pre-wrap break-words px-md py-sm ${
                    failed ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  {result.content}
                </Scroll>
              </Text>
            </Clip>
          )}
        </Stack>
      </ContentScope>
    </ToolCallCard>
  );
}
