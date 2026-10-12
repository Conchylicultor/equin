import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  useBlockTarget,
  useBlockTargetLink,
  useBlockTargetTitle,
} from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import type { ArtifactItem } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { ArtifactRow } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const descriptionIcon = symbol("description");

/**
 * The glyph, in one place: the registry draws it on the contribution and every
 * row draws it again, and a row whose icon disagreed with its own section's
 * would read as a different kind of thing.
 *
 * It is the Pages app's own icon: a row here opens that app, and the thing you
 * land in should wear the mark you clicked.
 */
export const PAGE_ICON = descriptionIcon;

/**
 * Why a row cannot be opened — and NOT an error.
 *
 * The page tools write to the shared instance (normally main) while this view
 * reads whichever instance served it, so a worktree's stale DB fork routinely
 * has no row for a page — or a block — that exists. There is no pane to open.
 */
const NOT_HERE = "Not in this instance — page writes go to the shared instance";

/**
 * The pages — and blocks of pages — a conversation wrote, changed or read, one
 * per line.
 */
export function PageSection({ items }: { items: ArtifactItem[] }) {
  return (
    <Stack gap="none">
      {items.map((item) => (
        <PageArtifactRow key={item.key} item={item} />
      ))}
    </Stack>
  );
}

/**
 * One row, resolving its own key — a page id, or a block id inside a page (a
 * read scoped to one card). A component per row so each can ask the shared
 * resolver: a page id is answered from the live pages list at no cost, a block
 * id by one reverse lookup.
 *
 * Until it resolves the row is a skeleton. The *count* is known from the
 * transcript alone — that is what the button shows — but a *title* is not, and
 * a raw `block-7f1a…` standing in for one would read as the answer rather than
 * as the wait for it.
 */
function PageArtifactRow({ item }: { item: ArtifactItem }) {
  const target = useBlockTarget(item.key);
  const title = useBlockTargetTitle(target);
  const link = useBlockTargetLink();

  if (target.kind === "pending") return <Loading variant="rows" count={1} />;
  if (target.kind === "missing" || target.kind === "error") {
    return (
      <ArtifactRow
        item={item}
        icon={PAGE_ICON}
        title={item.key}
        inertReason={
          target.kind === "missing" ? NOT_HERE : target.error.message
        }
      />
    );
  }
  // Resolved, but the pages list has not delivered the title yet.
  if (title === undefined) return <Loading variant="rows" count={1} />;
  return (
    <ArtifactRow
      item={item}
      icon={PAGE_ICON}
      // "Plugin system" for a page, "Plugin system › TODO" for a card in it.
      title={title}
      // Opens as a column to the RIGHT of the conversation, so the transcript
      // stays beside it — the page, or the block view for a block.
      activation={link(target)}
    />
  );
}
