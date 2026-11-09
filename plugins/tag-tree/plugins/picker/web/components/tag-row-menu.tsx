import { useRef, useState, type ReactNode } from "react";
import {
  TAG_PALETTE,
  type TagRow,
} from "@plugins/tag-tree/plugins/engine/core";
import {
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconPicker } from "@plugins/primitives/plugins/icon-picker/web";
import { symbol, type SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { TagPickerWrites } from "../internal/types";
import { fireWrite } from "../internal/surfaced";

const moreIcon = symbol("more-horiz");
const renameIcon = symbol("edit");
const addIcon = symbol("add");
const moveOutIcon = symbol("subdirectory-arrow-left");
const deleteIcon = symbol("delete");
const iconIcon = symbol("add-reaction");
const closeIcon = symbol("close");

/**
 * A picker row's `⋯` menu: Rename · Add sub-tag · Icon… (the Material
 * Symbols picker, in a panel hung off the `⋯` as the menu closes) · Move out
 * of its parent · Shade children (a parent's) · the colour swatches (`same as
 * parent` first, under a parent) · the caller's `extra` · Delete (immediate —
 * its children and carriers move to its parent; hidden when `deletable` is
 * false).
 */
export function TagRowMenu<Row extends TagRow>({
  tag,
  tags,
  writes,
  deletable,
  extra,
  onRename,
  onAddChild,
}: {
  tag: Row;
  tags: readonly TagRow[];
  writes: TagPickerWrites;
  deletable: boolean;
  extra: ReactNode;
  onRename(): void;
  onAddChild(): void;
}) {
  const [open, setOpen] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hasChildren = tags.some((t) => t.parentId === tag.id);
  const ramp = tag.childColors === "ramp";
  const setIcon = (icon: SavedSymbolName | null) => {
    setIconOpen(false);
    fireWrite(writes.update(tag.id, { icon }));
  };
  const parent =
    tag.parentId === null ? undefined : tags.find((t) => t.id === tag.parentId);
  const setColor = (color: string | null) => {
    setOpen(false);
    fireWrite(writes.update(tag.id, { color }));
  };
  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          ref={triggerRef}
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
          <DropdownMenuItem
            onClick={() => {
              setOpen(false);
              setIconOpen(true);
            }}
          >
            <Icon icon={iconIcon} className="size-4" />
            Icon…
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
          {hasChildren ? (
            <DropdownMenuCheckboxItem
              checked={ramp}
              onCheckedChange={() =>
                fireWrite(
                  writes.update(tag.id, { childColors: ramp ? null : "ramp" }),
                )
              }
            >
              Shade children
            </DropdownMenuCheckboxItem>
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
          {extra ? (
            <>
              <DropdownMenuSeparator />
              {extra}
            </>
          ) : null}
          {deletable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => fireWrite(writes.remove(tag.id))}
              >
                <Icon icon={deleteIcon} className="size-4" />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ControlPanelPopover
        anchor={triggerRef}
        open={iconOpen}
        onOpenChange={setIconOpen}
        side="right"
        align="start"
        label={`Icon of ${tag.name}`}
      >
        {/* The picker draws its own "Icon" heading. Mounted only while open:
          it loads its metadata on first mount. */}
        <ControlPanel.Section needs="picker">
          {iconOpen ? <IconPicker value={tag.icon} onSelect={setIcon} /> : null}
        </ControlPanel.Section>
        {tag.icon !== null ? (
          <ControlPanel.Footer>
            <ControlPanel.Row
              muted
              icon={<Icon icon={closeIcon} />}
              onSelect={() => setIcon(null)}
            >
              No icon
            </ControlPanel.Row>
          </ControlPanel.Footer>
        ) : null}
      </ControlPanelPopover>
    </>
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
