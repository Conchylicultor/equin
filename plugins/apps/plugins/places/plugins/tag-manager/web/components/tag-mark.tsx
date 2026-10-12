import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { runtimeSymbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  tagColor,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";

export interface TagMarkProps {
  tag: PlaceTag;
  /** The whole tree: a tag without a colour wears its nearest ancestor's. */
  tags: readonly PlaceTag[];
  className?: string;
}

/**
 * How a tag shows beside its name everywhere (the sidebar tree, the place
 * card's chips, the tag manager, a tag picker): its icon tinted with its
 * colour, else a dot of its colour. A tag with an inherited colour draws a
 * smaller, faded dot; a tag no colour reaches draws a dashed ring.
 *
 * The colour is user data (a stored hex), so it is the one thing painted
 * through `style`.
 */
export function TagMark({ tag, tags, className }: TagMarkProps) {
  const color = tagColor(tag.id, tags);
  if (tag.icon !== null) {
    return (
      <Icon
        icon={runtimeSymbol(tag.icon)}
        active
        className={cn(
          "size-4",
          color === null && "text-muted-foreground",
          className,
        )}
        style={color === null ? undefined : { color }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block rounded-full",
        color === null
          ? "size-2.5 border border-dashed border-muted-foreground"
          : tag.color === null
            ? "size-1.5 opacity-60"
            : "size-2.5",
        className,
      )}
      style={color === null ? undefined : { backgroundColor: color }}
    />
  );
}
