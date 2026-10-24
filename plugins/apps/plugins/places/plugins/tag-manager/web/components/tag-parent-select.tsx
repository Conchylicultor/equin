import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  placeTagTree,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  flattenTagTree,
  wouldCycle,
} from "@plugins/tag-tree/plugins/engine/core";
import { useTagTreeActions } from "@plugins/tag-tree/plugins/engine/web";

/** The select value standing for "no parent". */
const ROOT = "__root__";

/**
 * Where a tag sits: "Top level" or any other tag, listed in tree order and
 * indented by depth — never the tag itself or one of its descendants (the
 * move refuses a cycle; the list does not offer one). A new parent takes the
 * tag as its last child.
 */
export function TagParentSelect({
  tag,
  tags,
}: {
  tag: PlaceTag;
  tags: readonly PlaceTag[];
}) {
  const { move } = useTagTreeActions(placeTagTree);
  const options = useMemo(
    () => [
      { value: ROOT, label: "— Top level" },
      ...flattenTagTree(tags)
        .filter(({ tag: t }) => !wouldCycle(tag.id, t.id, tags))
        .map(({ tag: t, depth }) => ({
          value: t.id,
          label: `${"  ".repeat(depth)}${t.name}`,
        })),
    ],
    [tag.id, tags],
  );
  return (
    <Select
      items={options}
      value={tag.parentId ?? ROOT}
      onValueChange={(v: string | null) => {
        if (v === null) return;
        const parentId = v === ROOT ? null : v;
        if (parentId === tag.parentId) return;
        // Moved in as the new parent's last child.
        void move(tag.id, { parentId, targetId: null, zone: "after" });
      }}
    >
      <SelectTrigger aria-label={`Parent of ${tag.name}`} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
