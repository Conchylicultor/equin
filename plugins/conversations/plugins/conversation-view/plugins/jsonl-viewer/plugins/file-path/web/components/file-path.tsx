import { RowView } from "@plugins/network/plugins/live/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
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

// Every arm of the conversation read draws something: a path chip never
// collapses to nothing (which reads as "this call named no file").
export function FilePath({ filePath }: FilePathProps) {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);

  // A tool input without its path is malformed, and says so.
  if (!filePath) {
    return (
      <Text className="font-mono text-2xs text-destructive">no file path</Text>
    );
  }

  return (
    <RowView
      row={conversation}
      subject="the conversation"
      fallback={<Loading variant="block" className="h-3 w-32" />}
      missing={
        <Text className="font-mono text-2xs text-destructive" title={filePath}>
          {filePath} (conversation not found)
        </Text>
      }
    >
      {(row) => (
        <WorktreeFilePath filePath={filePath} attemptId={row.attemptId} />
      )}
    </RowView>
  );
}

function WorktreeFilePath({
  filePath,
  attemptId,
}: {
  filePath: string;
  attemptId: string;
}) {
  const openPane = useOpenPane();
  const relativePath = toRelativePath(filePath, attemptId);

  const fileTarget = openPane.to(
    filePeekPane,
    { worktree: attemptId, filePath },
    { mode: "push" },
  );

  return (
    <Inline gap="2xs" className="group/path">
      <SingleLineProvider value={true}>
        <Text
          as="button"
          side="start"
          {...activationProps(fileTarget, { isolate: true })}
          title={relativePath}
          data-file-path={relativePath}
          className="max-w-full font-mono text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {relativePath}
        </Text>
      </SingleLineProvider>
      <CopyButton
        text={relativePath}
        tooltip="Copy path"
        aspect="inline"
        className="opacity-0 pointer-events-none group-hover/path:opacity-100 group-hover/path:pointer-events-auto transition-opacity"
        onClick={(e) => e.stopPropagation()}
      />
    </Inline>
  );
}
