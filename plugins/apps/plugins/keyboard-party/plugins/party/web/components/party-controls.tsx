import { useEffect, useState, type RefObject } from "react";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { FieldRenderer } from "@plugins/config_v2/plugins/fields/web";
import { ControlPanelPopover } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { partyConfig } from "../../core";

const lockIcon = symbol("lock");
const settingsIcon = symbol("tune");

/** The Keyboard Lock API (Chromium): keys the browser would take reach the page. */
type KeyboardLockNavigator = Navigator & {
  keyboard?: { lock?: () => Promise<void>; unlock?: () => void };
};

/** Whether the stage is the fullscreen element, kept in sync via `fullscreenchange`. */
function useIsLocked(stageRef: RefObject<HTMLDivElement | null>) {
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    const onChange = () => {
      const isLocked = document.fullscreenElement === stageRef.current;
      setLocked(isLocked);
      const keyboard = (navigator as KeyboardLockNavigator).keyboard;
      // In fullscreen with the keyboard locked, Esc reaches the toy too; a
      // grown-up holds Esc to leave.
      if (isLocked) void keyboard?.lock?.();
      else keyboard?.unlock?.();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [stageRef]);
  return locked;
}

/**
 * The grown-up's corner: Lock (the stage full screen, with the keyboard
 * locked so system keys play the toy instead of leaving it) and the party's
 * settings. Hidden while locked — the child sees only the stage. Sits beside
 * the stage, not inside it, so its buttons keep their own keys.
 */
export function PartyControls({
  stageRef,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
}) {
  const locked = useIsLocked(stageRef);
  const [open, setOpen] = useState(false);
  if (locked) return null;

  const lock = () => {
    const stage = stageRef.current;
    if (!stage) throw new Error("PartyControls: stage not mounted");
    void stage.requestFullscreen();
    stage.focus();
  };

  return (
    <div className="kp-controls" onPointerDown={(e) => e.stopPropagation()}>
      <IconButton
        icon={lockIcon}
        label="Lock full screen (hold Esc to leave)"
        onClick={lock}
      />
      <ControlPanelPopover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) stageRef.current?.focus();
        }}
        align="start"
        side="bottom"
        label="Party settings"
        trigger={
          <IconButton
            icon={settingsIcon}
            label="Party settings"
            active={open}
          />
        }
      >
        <PartySettings />
      </ControlPanelPopover>
    </div>
  );
}

/** Every party config field, rendered generically — the same controls as Settings → Config. */
function PartySettings() {
  const values = useConfig(partyConfig) as Record<string, unknown>;
  const setConfig = useSetConfig(partyConfig);
  return (
    <>
      {Object.entries(partyConfig.fields).map(([key, field]) => (
        <FieldRenderer
          key={key}
          field={field}
          value={values[key]}
          onChange={(v) => setConfig(key as keyof typeof partyConfig.fields, v)}
        />
      ))}
    </>
  );
}
