import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  isStatusTag,
  tagPath,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { TagMark } from "@plugins/apps/plugins/places/plugins/tag-manager/web";

const closeIcon = symbol("close");

/** "Food & drinks › Restaurants › French" — a tag's place in the tree. */
export function tagPathLabel(tagId: string, tags: readonly PlaceTag[]): string {
  return tagPath(tagId, tags)
    .map((t) => t.name)
    .join(" › ");
}

/**
 * One tag as a chip: its mark, its name, its full path as the tooltip. Flags:
 * `auto` adds the AUTO badge (set from the place's Google type), `excluded`
 * strikes it through in the destructive tone (the sidebar's "Not tagged"),
 * and `onRemove` adds a × button.
 */
export function TagChip({
  tag,
  tags,
  auto = false,
  excluded = false,
  onRemove,
}: {
  tag: PlaceTag;
  tags: readonly PlaceTag[];
  auto?: boolean;
  excluded?: boolean;
  onRemove?: () => void;
}) {
  return (
    <Badge
      variant={excluded ? "destructive" : "muted"}
      shape="pill"
      title={tagPathLabel(tag.id, tags)}
      icon={<TagMark tag={tag} tags={tags} />}
    >
      <span className={cn(excluded && "line-through")}>{tag.name}</span>
      {auto ? (
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
          className="text-muted-foreground hover:text-foreground"
        >
          <Icon icon={closeIcon} className="size-3" />
        </button>
      ) : null}
    </Badge>
  );
}

/**
 * A place's tags as chips (its status tags left out — status has its own
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
    .filter((id) => !isStatusTag(id, tags))
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
