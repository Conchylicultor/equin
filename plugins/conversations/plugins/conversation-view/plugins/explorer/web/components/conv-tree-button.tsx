import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { convFileTreePane } from "../panes";
import { symbol } from "@plugins/ui/plugins/icons/core";

const folderIcon = symbol("folder");

export function ConvTreeButton() {
  const { isOpen, toggle } = convFileTreePane.useToggle({});

  // No `size` → inherits the toolbar's density, matching the other action icons.
  return (
    <IconButton
      icon={folderIcon}
      label="File explorer"
      variant={isOpen ? "secondary" : "ghost"}
      aria-pressed={isOpen}
      {...linkProps(toggle)}
    />
  );
}
