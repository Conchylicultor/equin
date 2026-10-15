import {
  CollapsibleChevron,
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useConversationById } from "@plugins/conversations/web";
import { DiffOrImageView } from "@plugins/primitives/plugins/diff-view/web";
import { gitStatusBadge } from "@plugins/conversations/plugins/conversation-view/plugins/code/web";
import type {
  PluginChangedFile,
  PluginChangeDiff,
  PluginReviewProps,
} from "@plugins/review/plugins/plugin-changes/core";

/** Strip border-* utilities from a gitStatusBadge string (keep only bg/text). */
function statusBadgeColor(status: string): string {
  return gitStatusBadge(status)
    .split(" ")
    .filter((c) => !c.startsWith("border-"))
    .join(" ");
}

const STATUS_LABEL: Record<string, string> = {
  modified: "modified",
  added: "new",
  untracked: "new",
  deleted: "deleted",
  renamed: "moved",
  copied: "branched",
  clean: "clean",
};

function FileRow({
  file,
  worktree,
}: {
  file: PluginChangedFile;
  worktree: string;
}) {
  const { open: expanded, triggerProps, contentProps } = useCollapsible();
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const basename = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const from = file.from && file.from !== file.path ? file.from : null;
  const label = STATUS_LABEL[file.status] ?? file.status;

  return (
    <div className="border-b border-border/40 last:border-b-0">
      <Line
        as="button"
        {...triggerProps}
        className="text-body w-full gap-sm px-sm py-xs text-left hover:bg-muted/50"
      >
        <CollapsibleChevron
          open={expanded}
          className={cn("size-3.5 text-muted-foreground", rigidClass())}
        />
        <Badge
          colorClass={statusBadgeColor(file.status)}
          className={rigidClass()}
        >
          {label}
        </Badge>
        <Text
          as="span"
          variant="caption"
          className={cn(fillClasses("x"), "group/path truncate")}
        >
          {from && (
            <>
              <span className="text-muted-foreground line-through">{from}</span>
              {/* eslint-disable-next-line spacing/no-adhoc-spacing -- inline arrow separator offset between from/to paths */}
              <span className="mx-1.5 text-muted-foreground">&rarr;</span>
            </>
          )}
          <span className="text-muted-foreground">{dir}</span>
          <span className="font-medium">{basename}</span>
          <CopyButton
            text={file.path}
            title="Copy path"
            aspect="inline"
            // eslint-disable-next-line spacing/no-adhoc-spacing -- inline gap after path text before copy button
            className="ml-1 text-muted-foreground opacity-0 pointer-events-none transition-opacity hover:text-foreground group-hover/path:opacity-100 group-hover/path:pointer-events-auto"
            onClick={(e) => e.stopPropagation()}
          />
        </Text>
        {/* `Line as={Text}` (rather than the usual `Text as={Line}`) keeps this
            stats group a <span>: it sits inside a <button>, whose content model is
            phrasing content, so Line's default <div> host would be invalid. */}
        <Line
          as={Text}
          variant="caption"
          className={cn("gap-sm tabular-nums", rigidClass())}
        >
          <span className="text-success">+{file.additions}</span>
          <span className="text-destructive">&minus;{file.deletions}</span>
        </Line>
      </Line>
      <FoldMotion {...contentProps}>
        <div className="bg-background">
          <DiffOrImageView
            worktree={worktree}
            path={file.path}
            base="main"
            from={file.from}
          />
        </div>
      </FoldMotion>
    </div>
  );
}

export function FileChangesSection({
  conversationId,
  plugin,
}: PluginReviewProps) {
  const conversation = useConversationById(conversationId);

  if (!conversation) {
    return <Loading className="px-xs" />;
  }

  if (plugin.files.length === 0) return null;

  return (
    <Clip className="rounded-md border border-border/40">
      {plugin.files.map((file) => (
        <FileRow
          key={file.path}
          file={file}
          worktree={conversation.attemptId}
        />
      ))}
    </Clip>
  );
}

export function hasFiles(plugin: PluginChangeDiff): boolean {
  return plugin.files.length > 0;
}
