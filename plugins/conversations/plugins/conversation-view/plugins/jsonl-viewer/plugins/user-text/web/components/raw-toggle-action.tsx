import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { useRowMarkdown } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { RowActionButton } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const codeIcon = symbol("code");

export function RawTextToggleAction({ event }: { event: JsonlEvent }) {
  const { markdownMode, setMarkdownMode } = useRowMarkdown();
  if (event.kind !== "user-text") return null;
  return (
    <RowActionButton
      tooltip={markdownMode ? "Show raw text" : "Show rich text"}
      active={markdownMode}
      onClick={() => setMarkdownMode(!markdownMode)}
    >
      <Icon icon={codeIcon} className="size-3" />
    </RowActionButton>
  );
}
