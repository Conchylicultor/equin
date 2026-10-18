import { useState } from "react";
import { scoreEndBeat } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { useSession } from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { FieldRenderer } from "@plugins/config_v2/plugins/fields/web";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { ButtonGroup } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { toggleLoop } from "../loop-actions";
import { loopConfig } from "../../shared/config";

const repeatIcon = symbol("repeat");
const optionsIcon = symbol("keyboard-arrow-down");

/** The options the menu lists, in order (every field of `loopConfig`). */
const OPTION_KEYS = ["showAhead", "restBeforeRepeat"] as const;

/**
 * The Loop control at the end of the player's transport strip
 * (`SonataPlayer.Transport`, after the scrubber): a split button.
 *
 *  - The main segment toggles the A–B practice loop in one click: with a
 *    region set it flips `enabled` (active = filled `default` variant); with
 *    none it loops the whole song (see `toggleLoop`). `L` does the same.
 *  - The chevron opens the loop's repeat options — "Show loop ahead" and "Rest
 *    before repeat", the user's `loopConfig` preferences, rendered by the
 *    shared config `FieldRenderer` (the same switch rows as the View popover).
 *    `LoopOptionsSync` pushes them into the session.
 *
 * Both segments wear the loop's state, so the split reads as one control.
 * Disabled until a song is loaded (the options stay reachable: they are
 * preferences, not part of a loop).
 */
export function LoopToggle() {
  const { loop, setLoop, score } = useSession();
  const hasScore = scoreEndBeat(score) > 0;
  const [open, setOpen] = useState(false);
  const values = useConfig(loopConfig);
  const setConfig = useSetConfig(loopConfig);
  const variant = loop?.enabled ? "default" : "ghost";

  return (
    <ButtonGroup>
      <IconButton
        icon={repeatIcon}
        label="Loop"
        tooltip="Loop"
        shortcut="l"
        variant={variant}
        disabled={!hasScore}
        onClick={() => toggleLoop({ loop, setLoop, score })}
      />
      <ControlPanelPopover
        open={open}
        onOpenChange={setOpen}
        align="end"
        side="bottom"
        label="Loop options"
        trigger={
          <IconButton
            icon={optionsIcon}
            glyph="small"
            label="Loop options"
            variant={open && !loop?.enabled ? "secondary" : variant}
          />
        }
      >
        {OPTION_KEYS.map((key) => (
          <FieldRenderer
            key={key}
            field={loopConfig.fields[key]}
            value={values[key]}
            onChange={(v) => setConfig(key, v)}
          />
        ))}
      </ControlPanelPopover>
    </ButtonGroup>
  );
}
