import { FloatingSurface } from "@plugins/primitives/plugins/overlay/plugins/floating-surface/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { LinkForm, type LinkFormResult } from "./link-form";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const languageIcon = symbol("language");

export interface LinkHoverCardProps {
  /** The `<a>` the card hangs under. */
  anchor: HTMLElement;
  /** The link's live href and text. */
  url: string;
  text: string;
  /** Edit mode (the form) rather than view mode (URL + Copy + Edit). */
  editing: boolean;
  /** Keeps the card open while the pointer travels onto it (hover intent). */
  surfaceProps: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
  onEdit: () => void;
  onApply: (result: LinkFormResult) => void;
  onRemove: () => void;
  /** Esc, or a press outside the card. */
  onClose: () => void;
}

/**
 * The small card under a hovered link.
 *
 * View mode: globe + the URL (truncated; a real `<a target=_blank>`, so a click
 * opens it in a new tab), Copy, and Edit. Every press in view mode is
 * `preventDefault`ed on mousedown, so clicking Copy or Edit never pulls focus
 * (and the caret) out of the editor the user is typing in.
 *
 * Edit mode: the shared `LinkForm` with URL + Title. Its URL field takes focus
 * — the one moment this otherwise focus-less surface asks for it, because the
 * user just clicked Edit to type.
 */
export function LinkHoverCard({
  anchor,
  url,
  text,
  editing,
  surfaceProps,
  onEdit,
  onApply,
  onRemove,
  onClose,
}: LinkHoverCardProps) {
  return (
    <FloatingSurface
      open
      anchor={anchor}
      side="bottom"
      align="start"
      width="xl"
      padding={editing ? "sm" : "xs"}
      onDismiss={onClose}
    >
      <div data-link-hover-card={editing ? "edit" : "view"} {...surfaceProps}>
        {editing ? (
          <LinkForm
            initialUrl={url}
            initialTitle={text}
            canRemove
            onApply={onApply}
            onRemove={onRemove}
            onCancel={onClose}
          />
        ) : (
          <Line className="gap-xs" onMouseDown={(e) => e.preventDefault()}>
            <Icon
              icon={languageIcon}
              aria-hidden
              className={cn(rigidClass(), "size-4 text-muted-foreground")}
            />
            <Fill>
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                data-link-hover-url
                className="hover:underline"
              >
                <Text variant="label">{url}</Text>
              </a>
            </Fill>
            <CopyButton text={url} tooltip="Copy link" />
            <Button variant="ghost" onClick={onEdit}>
              Edit
            </Button>
          </Line>
        )}
      </div>
    </FloatingSurface>
  );
}
