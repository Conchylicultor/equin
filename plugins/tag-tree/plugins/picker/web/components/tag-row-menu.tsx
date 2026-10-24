import { useState } from "react";
import {
  TAG_PALETTE,
  type TagRow,
} from "@plugins/tag-tree/plugins/engine/core";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { TagPickerWrites } from "../internal/types";
import { fireWrite } from "../internal/surfaced";

const moreIcon = symbol("more-horiz");
const renameIcon = symbol("edit");
const addIcon = symbol("add");
const moveOutIcon = symbol("subdirectory-arrow-left");
const deleteIcon = symbol("delete");

/**
 * A picker row's `⋯` menu: Rename · Add sub-tag · Move out of its parent ·
 * the colour swatches (`same as parent` first, under a parent) · Delete
 * (immediate — its children and carriers move to its parent).
 */
export function TagRowMenu({
  tag,
  tags,
  writes,
  onRename,
  onAddChild,
}: {
  tag: TagRow;
  tags: readonly TagRow[];
  writes: TagPickerWrites;
  onRename(): void;
  onAddChild(): void;
}) {
  const [open, setOpen] = useState(false);
  const parent =
    tag.parentId === null ? undefined : tags.find((t) => t.id === tag.parentId);
  const setColor = (color: string | null) => {
    setOpen(false);
    fireWrite(writes.update(tag.id, { color }));
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label="More"
        // `data-popup-open` is base-ui's open-state attribute.
        className="size-5 rounded-md text-muted-foreground hover:bg-background/60 data-popup-open:bg-background/60"
      >
        <Center axis="both" className="size-full">
          <Icon icon={moreIcon} className="size-4" />
        </Center>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start">
        <DropdownMenuItem onClick={onRename}>
          <Icon icon={renameIcon} className="size-4" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onAddChild}>
          <Icon icon={addIcon} className="size-4" />
          Add sub-tag
        </DropdownMenuItem>
        {parent ? (
          <DropdownMenuItem
            onClick={() =>
              fireWrite(
                writes.move(tag.id, {
                  parentId: parent.parentId,
                  targetId: parent.id,
                  zone: "after",
                }),
              )
            }
          >
            <Icon icon={moveOutIcon} className="size-4" />
            Move out of “{parent.name}”
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <Inset pad="xs">
          <Grid cols={6} gap="xs">
            {parent ? (
              <Swatch
                label="Same as parent"
                on={tag.color === null}
                onClick={() => setColor(null)}
              />
            ) : null}
            {TAG_PALETTE.map((color) => (
              <Swatch
                key={color}
                label={color}
                color={color}
                on={tag.color === color}
                onClick={() => setColor(color)}
              />
            ))}
          </Grid>
        </Inset>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => fireWrite(writes.remove(tag.id))}
        >
          <Icon icon={deleteIcon} className="size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One colour of the palette (or, without `color`, the dashed "same as parent"); ringed when current. */
function Swatch({
  label,
  color,
  on,
  onClick,
}: {
  label: string;
  color?: string;
  on: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
      className={cn(
        "aspect-square size-5 rounded-full",
        color === undefined && "border border-dashed border-muted-foreground",
        on && "outline-2 outline-offset-2 outline-foreground",
      )}
      style={color === undefined ? undefined : { backgroundColor: color }}
    />
  );
}
