import { useState } from "react";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  tagColor,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { TAG_PALETTE } from "../internal/palette";

const inheritIcon = symbol("subdirectory-arrow-right");
const noneIcon = symbol("format-color-reset");

/**
 * A tag's colour: a swatch of the colour it wears (its own solid; an
 * inherited one faded with a dashed ring; none a dashed empty square) opening
 * the palette, plus "Inherit from <parent>" (or "No colour" at the root),
 * which stores `null`.
 */
export function TagColorButton({
  tag,
  tags,
  onChange,
}: {
  tag: PlaceTag;
  tags: readonly PlaceTag[];
  onChange: (color: string | null) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const effective = tagColor(tag.id, tags);
  const parent =
    tag.parentId === null ? undefined : tags.find((t) => t.id === tag.parentId);
  const pick = (color: string | null) => {
    setOpen(false);
    void onChange(color);
  };
  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      size="picker"
      align="start"
      label={`Colour of ${tag.name}`}
      trigger={
        <button
          type="button"
          aria-label={`Colour of ${tag.name}`}
          title={
            tag.color !== null
              ? "Own colour"
              : effective !== null
                ? "Inherited from its parent — click to set"
                : "No colour"
          }
          className={cn(
            "size-5 rounded-md ring-1 ring-black/10 ring-inset",
            tag.color === null &&
              "outline-dashed outline-1 -outline-offset-4 outline-black/25",
            tag.color === null && effective !== null && "opacity-50",
          )}
          style={
            effective === null ? undefined : { backgroundColor: effective }
          }
        />
      }
    >
      <ControlPanel.Section label="Colour">
        <Grid cols={6} gap="xs">
          {TAG_PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              aria-pressed={tag.color === color}
              onClick={() => pick(color)}
              className={cn(
                "aspect-square rounded-md ring-1 ring-black/10 ring-inset",
                tag.color === color &&
                  "outline-2 outline-offset-2 outline-foreground",
              )}
              style={{ backgroundColor: color }}
            />
          ))}
        </Grid>
      </ControlPanel.Section>
      <ControlPanel.Footer>
        <ControlPanel.Row
          muted
          icon={<Icon icon={parent ? inheritIcon : noneIcon} />}
          onSelect={() => pick(null)}
        >
          {parent ? `Inherit from ${parent.name}` : "No colour"}
        </ControlPanel.Row>
      </ControlPanel.Footer>
    </ControlPanelPopover>
  );
}
