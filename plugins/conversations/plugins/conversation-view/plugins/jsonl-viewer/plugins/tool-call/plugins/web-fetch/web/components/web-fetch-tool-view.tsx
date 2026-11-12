import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { compactUrl, type PartialWebFetchInput } from "../internal/web-fetch";

/**
 * WebFetch fetches a page and answers a prompt against it. The row names the
 * page (host and path); opened, the prompt asked and the answer as markdown.
 */
export function WebFetchToolView({
  event,
  input,
}: ToolViewProps<PartialWebFetchInput>) {
  const { url, prompt, offset } = input;
  const result = event.result;
  const failed = result?.isError === true;

  return (
    <ToolCallCard
      event={event}
      summary={url ? compactUrl(url) : undefined}
      note={offset ? `· from char ${offset}` : undefined}
      aside={
        url && URL.canParse(url) ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title={url}
            className="text-caption text-muted-foreground hover:text-primary-text hover:underline"
          >
            Open
          </a>
        ) : undefined
      }
    >
      <Stack gap="sm">
        {prompt && (
          <Text
            as="p"
            variant="caption"
            tone="muted"
            className="whitespace-pre-wrap"
          >
            {prompt}
          </Text>
        )}
        {result &&
          (failed ? (
            <Text
              as="p"
              variant="caption"
              className="text-destructive whitespace-pre-wrap"
            >
              {result.content}
            </Text>
          ) : (
            <Markdown>{result.content}</Markdown>
          ))}
      </Stack>
    </ToolCallCard>
  );
}
