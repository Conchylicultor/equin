import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { CatNListing } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/code-listing/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const editIcon = symbol("edit");

interface EditedTextFilePayload {
  type: "edited_text_file";
  filename: string;
  snippet: string;
}

export function EditedTextFileView({ event }: AttachmentRendererProps) {
  const att = event.attachment as EditedTextFilePayload;

  return (
    <CollapsibleCard
      icon={<Icon icon={editIcon} className="size-3.5" />}
      label="Edited file"
      aside={<FilePath filePath={att.filename} />}
    >
      <CatNListing content={att.snippet ?? ""} filePath={att.filename} />
    </CollapsibleCard>
  );
}
