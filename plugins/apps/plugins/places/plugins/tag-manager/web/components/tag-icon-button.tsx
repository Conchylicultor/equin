import { useState } from "react";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconPicker } from "@plugins/primitives/plugins/icon-picker/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  runtimeSymbol,
  symbol,
  type SavedSymbolName,
} from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  tagColor,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";

const addIcon = symbol("add-reaction");
const closeIcon = symbol("close");

/**
 * A tag's icon: the icon tinted with the tag's colour (a faint "add" glyph
 * when it has none), opening the Material Symbols picker; "No icon" clears it
 * back to the colour dot.
 */
export function TagIconButton({
  tag,
  tags,
  onChange,
}: {
  tag: PlaceTag;
  tags: readonly PlaceTag[];
  onChange: (icon: SavedSymbolName | null) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const color = tagColor(tag.id, tags);
  const pick = (icon: SavedSymbolName | null) => {
    setOpen(false);
    void onChange(icon);
  };
  return (
    <ControlPanelPopover
      open={open}
      onOpenChange={setOpen}
      align="start"
      label={`Icon of ${tag.name}`}
      trigger={
        <Button
          variant="ghost"
          aspect="icon"
          aria-label={`Icon of ${tag.name}`}
          tooltip="Tag icon"
        >
          {tag.icon === null ? (
            <Icon icon={addIcon} className="text-muted-foreground" />
          ) : (
            <Icon
              icon={runtimeSymbol(tag.icon)}
              active
              style={color === null ? undefined : { color }}
            />
          )}
        </Button>
      }
    >
      {/* The picker draws its own "Icon" heading, so this band takes no label.
          Mounted only while open: it loads its metadata on first mount. */}
      <ControlPanel.Section needs="picker">
        {open && <IconPicker value={tag.icon} onSelect={pick} />}
      </ControlPanel.Section>
      {tag.icon !== null && (
        <ControlPanel.Footer>
          <ControlPanel.Row
            muted
            icon={<Icon icon={closeIcon} />}
            onSelect={() => pick(null)}
          >
            No icon
          </ControlPanel.Row>
        </ControlPanel.Footer>
      )}
    </ControlPanelPopover>
  );
}
