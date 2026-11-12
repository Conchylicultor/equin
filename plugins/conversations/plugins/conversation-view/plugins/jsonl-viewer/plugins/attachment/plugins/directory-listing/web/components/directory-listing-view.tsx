import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const folderIcon = symbol("folder");

interface DirectoryPayload {
  type: "directory";
  path?: string;
  displayPath?: string;
  /** Entry names, one per line. `""` for a directory that really is empty. */
  content?: string;
}

/**
 * The harness handing the agent a directory listing.
 *
 * The collapsed line is the directory and how much is in it —
 * `Directory  plugins/primitives/plugins/announce/web  · 4 entries` — which is
 * everything a reader needs to decide whether the names matter. The path comes
 * through `FilePath`, so it shortens to the worktree-relative form and carries
 * its own copy button.
 *
 * An empty listing is a real answer, not a missing one: the card says `· empty`
 * and the body says so in words. A payload with no `content` at all is a
 * different thing — the row exists to show entries, so it throws onto its own
 * row instead of rendering an empty card.
 */
export function DirectoryListingView({ event }: AttachmentRendererProps) {
  const att = event.attachment as DirectoryPayload;
  if (typeof att.content !== "string") {
    throw new Error("directory attachment carries no `content` listing");
  }
  const path = att.path ?? att.displayPath;
  if (!path) throw new Error("directory attachment carries no `path`");

  const entries = att.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return (
    <CollapsibleCard
      icon={<Icon icon={folderIcon} className="size-3.5" />}
      label="Directory"
      note={
        entries.length === 0
          ? "· empty"
          : `· ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`
      }
      aside={<FilePath filePath={path} />}
    >
      {entries.length === 0 ? (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground/60 italic"
        >
          Empty directory.
        </Text>
      ) : (
        <Scroll className="max-h-64">
          <Stack as="ul" gap="2xs">
            {entries.map((entry) => (
              <Text
                as="li"
                variant="code"
                tone="muted"
                key={entry}
                className="break-all"
              >
                {entry}
              </Text>
            ))}
          </Stack>
        </Scroll>
      )}
    </CollapsibleCard>
  );
}
