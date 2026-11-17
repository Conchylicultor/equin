import { cn, Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { useState } from "react";
import type { Color } from "../../core";
import {
  parseNumber,
  putNumber,
  showNumber,
  type Channel,
  type NumberChannel,
  type TextChannel,
} from "./channels";

export interface ChannelFieldProps {
  channel: Channel;
  color: Color;
  onChange: (color: Color) => void;
  /** Blur, Enter, or a scrub released. */
  onCommit: () => void;
  className?: string;
}

/** Pixels of horizontal drag per channel step while scrubbing. */
const SCRUB_PX_PER_STEP = 2;

const BOX = cn(
  "relative h-7 rounded-md border border-input bg-background",
  "focus-within:ring-1 focus-within:ring-ring",
);
const INPUT = cn(
  fillClasses("x"),
  "h-full bg-transparent pr-2xs font-mono text-caption tabular-nums outline-none",
);
const KEY = cn(
  rigidClass(),
  "h-full w-4 select-none font-mono text-3xs font-semibold text-muted-foreground",
);

/**
 * One channel of the value row: its letter, the field, its unit. Type a
 * number (applied as soon as it parses), ↑↓ to nudge (Shift ×10), or drag the
 * letter sideways to scrub. The hex channel is a plain text field.
 */
export function ChannelField(props: ChannelFieldProps) {
  return props.channel.kind === "number" ? (
    <NumberField {...props} channel={props.channel} />
  ) : (
    <HexField {...props} channel={props.channel} />
  );
}

function NumberField({
  channel,
  color,
  onChange,
  onCommit,
  className,
}: ChannelFieldProps & { channel: NumberChannel }) {
  // The text while the field is being edited; null shows the color's value.
  const [draft, setDraft] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const shown = showNumber(channel, color);
  const bad = draft !== null && parseNumber(draft) === null;

  const nudge = (direction: 1 | -1, big: boolean) => {
    const next = putNumber(
      channel,
      color,
      channel.get(color) + direction * channel.step * (big ? 10 : 1),
    );
    onChange(next);
    setDraft(showNumber(channel, next));
  };

  const onScrubStart = (e: React.PointerEvent<HTMLSpanElement>) => {
    const el = e.currentTarget;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    setScrubbing(true);
    // Scrub from where the gesture started, so clamping / gamut-fitting a
    // value mid-drag never compounds into the rest of the drag.
    const origin = color;
    const x0 = e.clientX;
    const v0 = channel.get(origin);
    const onMove = (ev: PointerEvent) => {
      const steps = Math.round((ev.clientX - x0) / SCRUB_PX_PER_STEP);
      onChange(
        putNumber(
          channel,
          origin,
          v0 + steps * channel.step * (ev.shiftKey ? 10 : 1),
        ),
      );
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      setScrubbing(false);
      onCommit();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  return (
    <Line
      as="label"
      title="Drag the letter, or ↑↓ (Shift ×10)"
      className={cn(BOX, bad && "border-destructive", className)}
    >
      <Center
        as="span"
        aria-hidden="true"
        onPointerDown={onScrubStart}
        className={cn(
          KEY,
          "cursor-ew-resize touch-none rounded-l-md hover:bg-muted hover:text-foreground",
          scrubbing && "bg-muted text-foreground",
        )}
      >
        {channel.key}
      </Center>
      <Input
        bare
        keep={transient("committed on every change: the colour is the state")}
        type="text"
        inputMode="decimal"
        spellCheck={false}
        aria-label={channel.label}
        aria-invalid={bad || undefined}
        value={draft ?? shown}
        onFocus={(e) => {
          setDraft(shown);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const v = parseNumber(raw);
          if (v !== null) onChange(putNumber(channel, color, v));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
            return;
          }
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            nudge(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
          }
        }}
        onBlur={() => {
          setDraft(null);
          onCommit();
        }}
        className={INPUT}
      />
      {channel.unit && (
        <span
          aria-hidden="true"
          className={cn(
            rigidClass(),
            "pr-xs font-mono text-3xs text-muted-foreground",
          )}
        >
          {channel.unit}
        </span>
      )}
    </Line>
  );
}

function HexField({
  channel,
  color,
  onChange,
  onCommit,
  className,
}: ChannelFieldProps & { channel: TextChannel }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = channel.get(color);
  const bad = draft !== null && channel.parse(color, draft) === null;

  return (
    <Line
      as="label"
      title="Hex"
      className={cn(BOX, bad && "border-destructive", className)}
    >
      <Center as="span" aria-hidden="true" className={KEY}>
        {channel.key}
      </Center>
      <Input
        bare
        keep={transient("committed on every change: the colour is the state")}
        type="text"
        spellCheck={false}
        aria-label={channel.label}
        aria-invalid={bad || undefined}
        value={draft ?? shown}
        onFocus={(e) => {
          setDraft(shown);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const next = channel.parse(color, raw);
          if (next) onChange(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onBlur={() => {
          setDraft(null);
          onCommit();
        }}
        className={INPUT}
      />
    </Line>
  );
}
