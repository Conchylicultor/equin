import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import {
  ToolCallCard,
  ToolCode,
  ToolCodeEmpty,
  ToolSection,
  toolResultStatus,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  parseSearchResult,
  plural,
  readSearchCall,
  type SearchOutcome,
} from "../internal/search-tools";

/** A path chip is a conversation lookup each; past this the rest stay text. */
const MAX_PATH_CHIPS = 100;

function FileList({ lines }: { lines: string[] }) {
  const chips = lines.slice(0, MAX_PATH_CHIPS);
  const rest = lines.slice(MAX_PATH_CHIPS);
  return (
    <Scroll className="max-h-72">
      <Stack gap="2xs" className="px-smd pb-sm">
        {chips.map((path, i) => (
          <FilePath key={`${i}-${path}`} filePath={path} />
        ))}
        {rest.length > 0 && (
          <Text
            as="pre"
            variant="caption"
            className="whitespace-pre-wrap break-words font-mono text-muted-foreground"
          >
            {rest.join("\n")}
          </Text>
        )}
      </Stack>
    </Scroll>
  );
}

function RawLines({ lines }: { lines: string[] }) {
  return <ToolCode>{lines.join("\n")}</ToolCode>;
}

function Results({
  outcome,
  files,
}: {
  outcome: SearchOutcome;
  files: boolean;
}) {
  if (outcome.lines.length === 0) {
    return (
      <ToolCode>
        <ToolCodeEmpty>No matches</ToolCodeEmpty>
      </ToolCode>
    );
  }
  return files ? (
    <FileList lines={outcome.lines} />
  ) : (
    <RawLines lines={outcome.lines} />
  );
}

/**
 * Grep and Glob search the checkout. The row names the pattern with its
 * filters and, once the result is in, how many files / lines / matches it
 * holds; opened, the matched files as clickable paths or the matching lines.
 */
export function SearchToolView({ event }: ToolRendererProps) {
  const call = readSearchCall(event);
  const result = event.result;
  const outcome =
    result && !result.isError
      ? parseSearchResult(call.shape, result.content)
      : undefined;

  return (
    <ToolCallCard
      event={event}
      summary={
        <>
          <span className="font-mono">{call.pattern}</span>
          {call.filters.length > 0 && (
            <span className="text-muted-foreground">
              {" "}
              {call.filters.join(" · ")}
            </span>
          )}
        </>
      }
      note={outcome && `· ${plural(outcome.count, outcome.unit)}`}
    >
      {result && (
        <ToolSection
          label="Output"
          copyText={result.content}
          status={toolResultStatus(event)}
        >
          {result.isError ? (
            <ToolCode tone={result.outcomeUnknown ? "default" : "error"}>
              {result.content}
            </ToolCode>
          ) : (
            outcome && (
              <Results outcome={outcome} files={call.shape === "files"} />
            )
          )}
        </ToolSection>
      )}
    </ToolCallCard>
  );
}
