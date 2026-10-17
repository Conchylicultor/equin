import { useState } from "react";
import { defineFieldShape } from "@plugins/config_v2/plugins/fields/web";
import { iconFieldType } from "@plugins/fields/plugins/icon/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ControlPanel,
  ControlPanelPopover,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconPicker } from "@plugins/primitives/plugins/icon-picker/web";
import { runtimeSymbol, symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const closeIcon = symbol("close");

/**
 * A square icon button showing the picked glyph (a dashed `+` while none is
 * chosen) that opens the icon grid; picking commits and closes, and Clear
 * resets to null — the owner's own default. The button sizes to itself, so it
 * takes the row's value cell `inline`.
 */
const IconRenderer = defineFieldShape({
  type: iconFieldType,
  useShape: ({ value, onChange }) => {
    const [open, setOpen] = useState(false);
    return {
      kind: "value",
      fit: "inline",
      control: (
        <ControlPanelPopover
          open={open}
          onOpenChange={setOpen}
          align="start"
          label="Pick icon"
          trigger={
            <Button
              variant={value === null ? "dashed" : "outline"}
              aspect="icon"
              aria-label="Pick icon"
            >
              <Icon icon={value === null ? addIcon : runtimeSymbol(value)} />
            </Button>
          }
        >
          {/* No section label: the icon block renders its own header. */}
          <ControlPanel.Section needs="picker">
            <IconPicker
              value={value}
              onSelect={(name) => {
                onChange(name);
                setOpen(false);
              }}
            />
          </ControlPanel.Section>
          {value !== null && (
            <ControlPanel.Footer>
              <ControlPanel.Row
                muted
                icon={<Icon icon={closeIcon} />}
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                Clear
              </ControlPanel.Row>
            </ControlPanel.Footer>
          )}
        </ControlPanelPopover>
      ),
    };
  },
});

export { IconRenderer };
