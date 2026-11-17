import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { prototypesGalleryPane } from "@plugins/apps/plugins/prototypes/plugins/gallery/web";
import { prototypesApp } from "@plugins/apps/plugins/prototypes/plugins/shell/core";

export function PrototypesGalleryButton() {
  // Like the Pages button: rendered inside the conversation pane, so
  // `useToggle`'s default push has a caller position — the gallery opens as a
  // column to the RIGHT of the conversation (the chat stays in view), and a
  // second click closes it. A real link: ⌘/middle-click opens a browser tab.
  const { isOpen, toggle } = prototypesGalleryPane.useToggle({});

  return (
    <IconButton
      icon={prototypesApp.icon}
      label="Prototypes"
      variant={isOpen ? "secondary" : "ghost"}
      aria-pressed={isOpen}
      {...linkProps(toggle)}
    />
  );
}
