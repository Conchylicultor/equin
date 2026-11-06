import type { CSSProperties, Ref } from "react";
import {
  SURFACE_LEVELS,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SwitchIndicator } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { Kbd } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  RATE_PRESETS,
  rateReadout,
  rateShort,
  sameRate,
} from "../internal/math";
import { mediaSettingsThemeScope } from "../internal/theme";
import { SpeedDial, type SetRate } from "./speed-dial";

const resetIcon = symbol("restart-alt");
const loopIcon = symbol("repeat");
const pipIcon = symbol("picture-in-picture-alt");

export interface SettingsPanelProps {
  open: boolean;
  /** Where it sits: placed above the gear by the player, which knows the pill. */
  place: CSSProperties;
  rate: number;
  settle: boolean;
  setRate: SetRate;
  loop: boolean;
  onLoop(): void;
  /** `null` = no picture in picture here (audio, or a browser offering none). */
  pip: { open: boolean; onToggle(): void } | null;
  ref?: Ref<HTMLElement>;
}

/**
 * The settings panel over the gear: the speed (readout, reset, the dial,
 * preset chips), then Loop and Picture in picture. Drawn at the pill's scale
 * (`mediaSettingsTheme`). Always mounted, so it fades and scales out as it
 * fades in.
 */
export function SettingsPanel({
  open,
  place,
  rate,
  settle,
  setRate,
  loop,
  onLoop,
  pip,
  ref,
}: SettingsPanelProps) {
  const atOne = sameRate(rate, 1);
  return (
    <Theme
      name={mediaSettingsThemeScope}
      surface="none"
      ref={ref}
      role="dialog"
      aria-label="Settings"
      aria-hidden={!open}
      inert={!open}
      data-open={open || undefined}
      style={place}
      className={cn(SURFACE_LEVELS.overlay, "mp-pop mp-settings")}
    >
      <section className="mp-settings-section">
        <div className="mp-settings-head">
          <Text variant="caption" className="mp-settings-title">
            Speed
          </Text>
          <button
            type="button"
            className="mp-reset"
            aria-label="Reset speed"
            data-hidden={atOne || undefined}
            tabIndex={atOne ? -1 : undefined}
            onClick={() => setRate(1)}
          >
            <Icon icon={resetIcon} />
          </button>
          <Text variant="subheading" className="mp-speed tabular-nums">
            {rateReadout(rate)}
          </Text>
        </div>
        <SpeedDial
          focused={open}
          rate={rate}
          settle={settle}
          setRate={setRate}
        />
        <div className="mp-chips">
          {RATE_PRESETS.map((r) => (
            <button
              key={r}
              type="button"
              className="mp-chip"
              aria-pressed={sameRate(rate, r)}
              onClick={() => setRate(r)}
            >
              <Text variant="caption" className="tabular-nums">
                {rateShort(r)}
              </Text>
            </button>
          ))}
        </div>
      </section>
      <div className="mp-sep" />
      <div className="mp-items">
        <button
          type="button"
          className="mp-item"
          role="switch"
          aria-checked={loop}
          onClick={onLoop}
        >
          <Icon icon={loopIcon} />
          <Text variant="body" className="mp-item-label">
            Loop
          </Text>
          <Kbd>R</Kbd>
          <SwitchIndicator checked={loop} />
        </button>
        {pip && (
          <button type="button" className="mp-item" onClick={pip.onToggle}>
            <Icon icon={pipIcon} />
            <Text variant="body" className="mp-item-label">
              {pip.open ? "Back to the page" : "Picture in picture"}
            </Text>
            <Kbd>P</Kbd>
          </button>
        )}
      </div>
    </Theme>
  );
}
