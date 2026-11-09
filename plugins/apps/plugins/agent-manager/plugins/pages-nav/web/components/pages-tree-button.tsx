import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { pagesTreePane } from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const descriptionIcon = symbol("description");

export function PagesTreeButton() {
  // Rendered inside the conversation pane, so `useToggle`'s default push has a
  // caller position: the tree opens as a column to the RIGHT of the
  // conversation, and clicking a page adds the detail column beyond it.
  const { isOpen, toggle } = pagesTreePane.useToggle({});

  return (
    <IconButton
      icon={descriptionIcon}
      label="Pages"
      variant={isOpen ? "secondary" : "ghost"}
      aria-pressed={isOpen}
      {...linkProps(toggle)}
    />
  );
}
