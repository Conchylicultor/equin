import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Fill,
  fillClasses,
} from "@plugins/primitives/plugins/css/plugins/fill/web";
import { SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import type { Color } from "../../core";
import { ChannelField } from "./channel-field";
import {
  channelsFor,
  formatColor,
  isColorFormat,
  type ColorFormat,
} from "./channels";

const FORMAT_OPTIONS = [
  { id: "hex", label: "HEX" },
  { id: "oklch", label: "OKLCH" },
  { id: "hsl", label: "HSL" },
] as const satisfies readonly { id: ColorFormat; label: string }[];

/** How long the chosen format is remembered on this device. */
const FORMAT_TTL = 365 * 24 * 60 * 60 * 1000;

export interface ColorValueFieldsProps {
  color: Color;
  onChange: (color: Color) => void;
  /** A field blurred / Enter pressed, or a scrub released. */
  onCommit: () => void;
  /** Add an opacity (A %) field. */
  showAlpha?: boolean;
  className?: string;
}

/**
 * The value row: a HEX · OKLCH · HSL switch (remembered per device) over one
 * field per channel of that format — L % · C · H °, H ° · S % · L %, or one
 * hex field — plus A % when alpha is edited, and a Copy of the value in the
 * shown format.
 */
export function ColorValueFields({
  color,
  onChange,
  onCommit,
  showAlpha = false,
  className,
}: ColorValueFieldsProps) {
  const [stored, setFormat] = useDraft<ColorFormat>(
    "color-picker-format",
    "oklch",
    { ttl: FORMAT_TTL },
  );
  // A stored value from an older build (or a hand-edited one) is not trusted.
  const format = isColorFormat(stored) ? stored : "oklch";
  const channels = channelsFor(format, showAlpha);

  return (
    <Stack gap="xs" className={className}>
      <Line>
        <SectionLabel className="px-2xs text-3xs">Value</SectionLabel>
        <Fill />
        <SegmentedControl
          options={FORMAT_OPTIONS}
          value={format}
          onChange={setFormat}
          variant="ghost"
        />
      </Line>
      <Stack direction="row" gap="xs" align="center">
        {channels.map((ch) => (
          <ChannelField
            // A format switch swaps the set: key by format so no field keeps
            // another channel's in-progress draft.
            key={`${format}:${ch.key}`}
            channel={ch}
            color={color}
            onChange={onChange}
            onCommit={onCommit}
            className={fillClasses("x")}
          />
        ))}
        <CopyButton
          text={formatColor(color, format)}
          tooltip={`Copy ${format.toUpperCase()}`}
        />
      </Stack>
    </Stack>
  );
}
