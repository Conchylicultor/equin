import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { afterOpen } from "@plugins/primitives/plugins/link-gesture/core";
import { useConversationById } from "@plugins/conversations/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { filePeekPane } from "@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web";
import { useCloseArtifacts } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/web";
import type { ArtifactItem } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { PACKAGED_SKILL_REASON, skillFilePath } from "../internal/skills";
import { symbol } from "@plugins/ui/plugins/icons/core";

const boltIcon = symbol("bolt");

/** The skills' glyph. */
export const SKILL_ICON = boltIcon;

/**
 * The skills this conversation loaded, as a wrapped strip of name chips.
 *
 * A skill's name IS its whole identity — `plan`, `debug`, `css` — so a column of
 * one-word rows would be mostly empty space. Chips fit a dozen of them in the
 * room three rows would take. The name is monospace because it is an id the
 * reader would type, not prose.
 *
 * No relation mark: a skill is always only *referenced*, and a mark that never
 * varies says nothing.
 */
export function SkillSection({ items }: { items: ArtifactItem[] }) {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  const openPane = useOpenPane();
  const close = useCloseArtifacts();

  const worktree = conversation?.attemptId;

  return (
    <Cluster gap="2xs" className="px-sm">
      {items.map((item) => {
        const path = skillFilePath(item.key);

        // A plugin skill (`<plugin>:<skill>`) ships inside the harness install,
        // not in this checkout. Saying so on a chip that plainly cannot be
        // clicked beats a clickable chip that opens a "file not found" pane.
        // The same shape covers the moment before the conversation's worktree
        // is known, which is a different sentence in the tooltip.
        if (path === null || worktree === undefined) {
          return (
            <Badge
              key={item.key}
              mono
              title={
                path === null
                  ? PACKAGED_SKILL_REASON
                  : "Waiting for the conversation's worktree"
              }
              className="opacity-60"
            >
              {item.key}
            </Badge>
          );
        }

        return (
          <LinkChip
            key={item.key}
            mono
            title={`Open ${path}`}
            activation={afterOpen(
              openPane.to(
                filePeekPane,
                { worktree, filePath: path },
                { mode: "push" },
              ),
              close,
            )}
          >
            {item.key}
          </LinkChip>
        );
      })}
    </Cluster>
  );
}
