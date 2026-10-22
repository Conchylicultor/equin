import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  AssetThumbnail,
  ImageGallery,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import {
  fileRefForPath,
  fileUrl,
} from "@plugins/primitives/plugins/file-viewer/core";
import { useConversationById } from "@plugins/conversations/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import type { ArtifactItem } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { screenshotName } from "../../core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const photoCameraIcon = symbol("photo-camera");

/** The pictures' glyph, the same one the Screenshot toolbar button wears. */
export const SCREENSHOT_ICON = photoCameraIcon;

/**
 * The pictures the conversation looked at, four to a row.
 *
 * A picture is its own label, so this kind does not list rows: a thumbnail grid
 * says in one glance what a column of file names cannot. The file name is the
 * tooltip, and the full-window viewer shows it in its top bar.
 *
 * The whole grid is ONE `ImageGallery`, so opening any thumbnail lets ← / →
 * walk the conversation's other screenshots without going back to the popover.
 *
 * The popover deliberately stays open underneath. The viewer renders inside
 * this section's React tree (that is how `ViewerThumbnail` keeps a popover from
 * reading the viewer's own clicks as an outside press), so dismissing the
 * popover would unmount the viewer the click just opened. Closing the viewer
 * lands the reader back on the grid, which is where they would want to pick the
 * next picture anyway.
 */
export function ScreenshotSection({ items }: { items: ArtifactItem[] }) {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  // A picture's address depends on its worktree (a path inside it reads from
  // the checkout, any other from the host), so until the conversation row
  // arrives there is no image to show — a loading state, not an empty grid.
  if (conversation === null) {
    return <Loading variant="cards" count={items.length} />;
  }

  return (
    <ImageGallery>
      <Grid cols={4} gap="2xs" align="center" className="px-sm">
        {items.map((item) => {
          const name = screenshotName(item.key);
          return (
            <span key={item.key} title={item.key} className="block">
              <AssetThumbnail
                asset={fileUrl(
                  fileRefForPath(conversation.attemptId, item.key, {
                    root: conversation.worktreePath,
                  }),
                )}
                image={{ name, sourceLabel: "Screenshot" }}
                size="chip"
              />
            </span>
          );
        })}
      </Grid>
    </ImageGallery>
  );
}
