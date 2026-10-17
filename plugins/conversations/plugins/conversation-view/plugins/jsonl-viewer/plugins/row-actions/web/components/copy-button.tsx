import { useCopyToClipboard } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { RowActionButton } from "./row-action-button";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const checkIcon = symbol("check");
const contentCopyIcon = symbol("content-copy");

export function CopyTextAction({
  text,
  title = "Copy",
}: {
  text: string;
  title?: string;
}) {
  const { copy, copied } = useCopyToClipboard(text);
  return (
    <RowActionButton tooltip={title} onClick={copy}>
      {copied ? (
        <Icon icon={checkIcon} className="size-3" />
      ) : (
        <Icon icon={contentCopyIcon} className="size-3" />
      )}
    </RowActionButton>
  );
}
