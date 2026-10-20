import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { useRowMarkdown } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const codeIcon = symbol("code");

export function RawTextToggleAction({ event }: { event: JsonlEvent }) {
  const { markdownMode, setMarkdownMode } = useRowMarkdown();
  if (event.kind !== "user-text") return null;
  return (
    <IconButton
      icon={codeIcon}
      label={markdownMode ? "Show raw text" : "Show rich text"}
      active={!markdownMode}
      onClick={() => setMarkdownMode(!markdownMode)}
    />
  );
}
