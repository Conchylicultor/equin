import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { rowOrStale, useLive } from "@plugins/network/plugins/live/web";
import { pageData, pagesTree } from "@plugins/page/plugins/editor/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { pageDetailPane } from "../panes";
import { PageDetail } from "../slots";
import { useTrashPage } from "../internal/use-trash-page";

const moreIcon = symbol("more-horiz");
const deleteIcon = symbol("delete");

/**
 * The page's "⋯" menu in the page-detail header (`pageDetailPane.Actions`):
 * every `PageDetail.MenuItem` contribution (favorites, …), then — after a
 * separator, as the one destructive entry — Move to trash, which this plugin
 * owns because it owns what trashing the open page does to the pane.
 */
export function PageMenuAction() {
  const { pageId } = pageDetailPane.useParams();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            aspect="icon"
            aria-label="Page actions"
            tooltip="Page actions"
          />
        }
      >
        <Icon icon={moreIcon} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <PageDetail.MenuItem.Render>
          {(item) => <item.component pageId={pageId} />}
        </PageDetail.MenuItem.Render>
        <DropdownMenuSeparator />
        <MoveToTrashItem pageId={pageId} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MoveToTrashItem({ pageId }: { pageId: string }) {
  const trashPage = useTrashPage();
  // The title names the undo entry, so the item waits for the page's row (the
  // header already holds it — a cache hit). Disabled is the truthful render
  // both while it loads and once the page is gone (nothing left to trash).
  const row = rowOrStale(useLive(pagesTree, { id: pageId })) ?? null;
  return (
    <DropdownMenuItem
      variant="destructive"
      disabled={row === null}
      onClick={() => {
        if (row === null) return;
        return trashPage({ id: pageId, title: pageData(row).title });
      }}
    >
      <Icon icon={deleteIcon} />
      Move to trash
    </DropdownMenuItem>
  );
}
