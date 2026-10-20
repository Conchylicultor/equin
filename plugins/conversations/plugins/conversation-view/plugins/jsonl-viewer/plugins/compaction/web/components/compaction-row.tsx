import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  ContextFold,
  formatTokenCount,
  useHostedContext,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { growClass } from "@plugins/primitives/plugins/css/plugins/grow/web";
import { Separator } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const historyIcon = symbol("history");

type CompactionEvent = Extract<JsonlEvent, { kind: "compaction" }>;

/** `316k → 12k` when both counts are known, else nothing. */
function tokenDrop(e: CompactionEvent): string | null {
  if (e.preTokens === undefined || e.postTokens === undefined) return null;
  return `${formatTokenCount(e.preTokens)} → ${formatTokenCount(e.postTokens)}`;
}

/**
 * A context compaction: one thin rule across the transcript, so the thread
 * reads straight through it. The summary the agent continues from and the
 * files it re-read fold behind the rule — the summary as rendered markdown,
 * never as a message the user sent — and so does the context the harness
 * re-injected right after (a host: `hostsContext`), as a nested fold.
 */
export function CompactionRow({ event }: { event: JsonlEvent }) {
  const e = event as CompactionEvent;
  const drop = tokenDrop(e);
  const label =
    e.trigger === "manual" ? "Compacted on request" : "Context compacted";
  const hosted = useHostedContext();
  const hasFold =
    e.summary !== undefined || e.files.length > 0 || hosted !== null;

  const rule = (
    <>
      <Separator aria-hidden className={growClass()} />
      <Stack as="span" direction="row" gap="xs" align="center">
        <Icon icon={historyIcon} className="size-3.5" />
        {label}
        {drop && <span className="tabular-nums">· {drop}</span>}
        {hasFold && <CollapsibleChevron className="size-3" />}
      </Stack>
      <Separator aria-hidden className={growClass()} />
    </>
  );

  if (!hasFold) {
    return (
      <Text
        as="div"
        variant="caption"
        className="px-xs py-xs text-muted-foreground"
      >
        <Stack direction="row" gap="sm" align="center">
          {rule}
        </Stack>
      </Text>
    );
  }

  return (
    <Collapsible className="px-xs py-xs">
      <CollapsibleTrigger className="text-caption text-muted-foreground hover:text-foreground">
        <Stack
          as="span"
          direction="row"
          gap="sm"
          align="center"
          className={growClass()}
        >
          {rule}
        </Stack>
      </CollapsibleTrigger>
      {/* The fold hangs off the rule: a left hairline marks it as the compaction's. */}
      <CollapsibleContent className="pt-sm pl-xs">
        <Stack gap="md" className="border-l border-border pl-md">
          {e.summary !== undefined && (
            <ContentScope>
              <Text as="div" variant="body" className="text-foreground/85">
                <Markdown>{e.summary}</Markdown>
              </Text>
            </ContentScope>
          )}
          {e.files.length > 0 && (
            <Stack gap="2xs">
              <Text
                as="div"
                variant="caption"
                className="text-muted-foreground"
              >
                Re-read after compacting · {e.files.length}{" "}
                {e.files.length === 1 ? "file" : "files"}
              </Text>
              {e.files.map((f) => (
                <Stack key={f.path} direction="row" gap="xs" align="center">
                  <FilePath filePath={f.path} />
                  {f.lines !== undefined && (
                    <Text
                      as="span"
                      variant="caption"
                      className="text-2xs text-muted-foreground tabular-nums"
                    >
                      {f.lines} {f.lines === 1 ? "line" : "lines"}
                    </Text>
                  )}
                </Stack>
              ))}
            </Stack>
          )}
          {hosted !== null && (
            <ContextFold label="Context re-injected" members={hosted} />
          )}
        </Stack>
      </CollapsibleContent>
    </Collapsible>
  );
}
