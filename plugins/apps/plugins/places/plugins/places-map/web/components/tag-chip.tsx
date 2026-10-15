import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import {
  hoverRevealGroup,
  hoverRevealTarget,
} from "@plugins/primitives/plugins/hover-reveal/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  isRoleTag,
  tagColor,
  tagPath,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { TagMark } from "@plugins/apps/plugins/places/plugins/tag-manager/web";

const closeIcon = symbol("close");
const autoIcon = symbol("auto-awesome");

/** "Food & drinks › Restaurants › French" — a tag's place in the tree. */
export function tagPathLabel(tagId: string, tags: readonly PlaceTag[]): string {
  return tagPath(tagId, tags)
    .map((t) => t.name)
    .join(" › ");
}

/**
 * One tag as a chip: its mark, its name, its full path as the tooltip. Flags:
 * `tinted` paints it as a soft pill in the tag's own colour (the place card),
 * `auto` adds the AUTO badge (set from the place's Google type) — a ✨ mark on
 * a tinted chip — `excluded`
 * strikes it through in the destructive tone (the sidebar's "Not tagged"),
 * and `onRemove` adds a × button.
 */
export function TagChip({
  tag,
  tags,
  auto = false,
  excluded = false,
  tinted = false,
  onRemove,
}: {
  tag: PlaceTag;
  tags: readonly PlaceTag[];
  auto?: boolean;
  tinted?: boolean;
  excluded?: boolean;
  onRemove?: () => void;
}) {
  const color = tinted ? tagColor(tag.id, tags) : null;
  const title = tagPathLabel(tag.id, tags);
  return (
    <Badge
      variant={excluded ? "destructive" : "muted"}
      shape="pill"
      title={
        auto && tinted ? `${title} — set from the Google place type` : title
      }
      icon={<TagMark tag={tag} tags={tags} />}
      // The tag's colour is user data: painted through `style`.
      style={
        color === null
          ? undefined
          : {
              background: `color-mix(in srgb, ${color} 13%, transparent)`,
              color: `color-mix(in srgb, ${color} 50%, black)`,
            }
      }
      className={cn(tinted && hoverRevealGroup)}
    >
      <span className={cn(excluded && "line-through")}>{tag.name}</span>
      {auto && tinted ? (
        <Icon icon={autoIcon} className="size-3 opacity-60" />
      ) : auto ? (
        <Badge
          variant="warning"
          title="Set automatically from the Google place type"
        >
          AUTO
        </Badge>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${tag.name}`}
          onClick={onRemove}
          className={
            tinted
              ? cn("text-current", hoverRevealTarget)
              : "text-muted-foreground hover:text-foreground"
          }
        >
          <Icon icon={closeIcon} className="size-3" />
        </button>
      ) : null}
    </Badge>
  );
}

/**
 * A place's tags as chips (Been / Want to go left out — each has its own
 * column), at most `max` of them then `+n`.
 */
export function PlaceTagChips({
  tagIds,
  tags,
  max = 3,
}: {
  tagIds: readonly string[];
  tags: readonly PlaceTag[];
  max?: number;
}) {
  const byId = new Map<string, PlaceTag>(tags.map((t) => [t.id, t]));
  const shown = tagIds
    .filter((id) => !isRoleTag(id, tags))
    .map((id) => byId.get(id))
    .filter((t): t is PlaceTag => t !== undefined);
  return (
    <Cluster gap="2xs">
      {shown.slice(0, max).map((t) => (
        <TagChip key={t.id} tag={t} tags={tags} />
      ))}
      {shown.length > max ? (
        <Badge variant="muted" shape="pill">{`+${shown.length - max}`}</Badge>
      ) : null}
    </Cluster>
  );
}
