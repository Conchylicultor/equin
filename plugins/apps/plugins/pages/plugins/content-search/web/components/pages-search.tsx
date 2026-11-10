import { useState } from "react";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { PageIcon } from "@plugins/page/plugins/editor/web";
import { isEmoji } from "@plugins/ui/plugins/icons/plugins/emoji/core";
import { QuickFindDialog } from "@plugins/search/plugins/quick-find/web";
import { pageDetailPane } from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const searchIcon = symbol("search");

/**
 * The mockup's 10px leading inset, spelled as a sum of density-ramp steps so it
 * scales with the density preset.
 */
const FIELD_STYLE = { paddingLeft: "calc(var(--space-sm) + var(--space-2xs))" };

/**
 * Sidebar "Search" trigger: a filled, field-shaped button (32px, hairline
 * border, the search glyph then "Search" in muted label text) that opens the reusable
 * QuickFindDialog scoped to the "pages" source. A result is a link to the page
 * in the page-detail pane (⌘/middle-click: a new browser tab). It reads as a search field but is a button: the
 * typing happens in the dialog.
 */
export function PagesSearch() {
  const [open, setOpen] = useState(false);
  const openPane = useOpenPane();

  return (
    <>
      {/* No bottom padding: the section heads below open with their own. */}
      <div className="rail-follow pt-sm">
        {/* A field's placeholder, not a nav row: the label rung (13px), a
            step below the tree rows under it; its glyph follows (icon-auto). */}
        <Row
          bordered
          icon={<Icon icon={searchIcon} />}
          onClick={() => setOpen(true)}
          style={FIELD_STYLE}
          className="h-8 rounded-lg bg-muted text-label font-normal text-muted-foreground hover:border-popover-border"
        >
          Search
        </Row>
      </div>
      <QuickFindDialog
        open={open}
        onOpenChange={setOpen}
        sources={["pages"]}
        placeholder="Search pages…"
        resultActivation={(r) =>
          openPane.to(pageDetailPane, { pageId: r.entityId }, { mode: "push" })
        }
        renderIcon={(r) => {
          // Search metadata is untyped JSON; the reindexer writes the page's
          // emoji icon under `icon`.
          const icon: unknown = r.metadata?.icon;
          return (
            <PageIcon
              icon={typeof icon === "string" && isEmoji(icon) ? icon : null}
              className="size-4"
            />
          );
        }}
      />
    </>
  );
}
