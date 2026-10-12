import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { filePeekPane } from "@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SingleLineProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

export function toRelativePath(filePath: string, attemptId: string): string {
  // The attempt id can sit at a path boundary (`/att-xxx/…`) or as the suffix
  // of an encoded worktree-dir segment (`…-worktrees-att-xxx/…`), so anchor on
  // `<attemptId>/` rather than requiring a leading slash.
  const marker = `${attemptId}/`;
  const idx = filePath.indexOf(marker);
  return idx >= 0 ? filePath.slice(idx + marker.length) : filePath;
}

interface FilePathProps {
  filePath: string;
}

export function FilePath({ filePath }: FilePathProps) {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  const openPane = useOpenPane();

  if (!conversation) return null;
  if (!filePath) return null;

  const relativePath = toRelativePath(filePath, conversation.attemptId);

  const fileTarget = openPane.to(
    filePeekPane,
    { worktree: conversation.attemptId, filePath },
    { mode: "push" },
  );

  return (
    <Inline gap="2xs" className="group/path max-w-full">
      <SingleLineProvider value={true}>
        <Text
          as="button"
          side="start"
          {...activationProps(fileTarget, { isolate: true })}
          title={relativePath}
          className="max-w-full font-mono text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {relativePath}
        </Text>
      </SingleLineProvider>
      <CopyButton
        text={relativePath}
        title="Copy path"
        aspect="inline"
        className="opacity-0 pointer-events-none group-hover/path:opacity-100 group-hover/path:pointer-events-auto transition-opacity"
        onClick={(e) => e.stopPropagation()}
      />
    </Inline>
  );
}
