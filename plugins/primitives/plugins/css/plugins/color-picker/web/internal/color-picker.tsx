import {
  cn,
  ControlSizeProvider,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, useRef, useCallback, useEffect } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ResourceView } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  useRecordUsage,
  useRecentUsage,
} from "@plugins/primitives/plugins/usage-rank/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Color } from "../../core";
import { ColorArea } from "./color-area";
import { HueSlider } from "./hue-slider";
import { AlphaSlider } from "./alpha-slider";
import { ColorValueFields } from "./color-value-fields";
import {
  SwatchGrid,
  colorsMatch,
  displayName,
  swatchColor,
  type Swatch,
} from "./swatch-grid";

const resetIcon = symbol("restart-alt");
const eyedropperIcon = symbol("colorize");

/** The usage-rank namespace every picker's commits are recorded under — one Recent row app-wide. */
const RECENT_USAGE = "color-picker";
/** How many recent colors the Recent row shows. */
const RECENT_COUNT = 10;

const FALLBACK = Color.fromOklch(0.623, 0.214, 259.1);

export interface ColorPickerProps {
  value: string;
  /** Every change, per pointer move — an `oklch(…)` string. */
  onChange: (color: string) => void;
  /**
   * The value settled — a drag or scrub released, an arrow key let go, a field
   * blurred / Enter, a swatch, recent or eyedropper pick, Reset, or the
   * before-swatch revert. An `oklch(…)` string. Where `onChange` previews,
   * this is the moment to persist.
   */
  onCommit?: (color: string) => void;
  /** Suggestions — plain CSS colors, or named (`{ name, color }`). */
  swatches?: readonly Swatch[];
  showAlpha?: boolean;
  /**
   * Shows the header: a before / after swatch (before = the value the picker
   * opened with; click it to go back), this title, and what the color is (a
   * suggestion's name, "Default", or "Custom").
   */
  title?: string;
  /** The caller's default: adds a Reset to it (disabled while already there). */
  defaultValue?: string;
  className?: string;
}

interface EyeDropperApi {
  open(): Promise<{ sRGBHex: string }>;
}
type EyeDropperCtor = new () => EyeDropperApi;

/** The browser's EyeDropper (Chromium), or null where it does not exist. */
function eyeDropperCtor(): EyeDropperCtor | null {
  if (typeof window === "undefined" || !("EyeDropper" in window)) return null;
  return (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper;
}

export function ColorPicker({
  value,
  onChange,
  onCommit,
  swatches,
  showAlpha = false,
  title,
  defaultValue,
  className,
}: ColorPickerProps) {
  const recordUsage = useRecordUsage();
  const lastEmitted = useRef(value);
  const [color, setColor] = useState(() => Color.fromCss(value) ?? FALLBACK);
  // The value the picker opened with — the "before" half of the header swatch.
  const [before] = useState(() => Color.fromCss(value) ?? FALLBACK);
  // Commits fire from event handlers that close over an older render (a drag's
  // pointerup); the ref is the color as of the last emit.
  const current = useRef(color);
  // The `value` prop as of the last effect run: only a CHANGE of the prop is
  // adopted, so a caller that does not echo our emits back (a preview that
  // persists on commit) never has its stale `value` snap the picker back.
  const seenValue = useRef(value);

  useEffect(() => {
    if (value === seenValue.current) return;
    seenValue.current = value;
    // The round-trip echo of our own emit: already shown.
    if (value === lastEmitted.current) return;
    const parsed = Color.fromCss(value);
    if (parsed && !parsed.equals(current.current)) {
      // Echo-guard: the effect adopts an EXTERNAL `value` change only, suppressing the round-trip echo of our own emits (parent re-passes our oklch string as `value`). Going fully-controlled (derive color from `value` each render) is unsafe here: config-backed callers (fields/color/config, theme-customizer) write `value` asynchronously, so deriving would lag/fight the slider position — the documented fallback in the burndown plan.
      setColor(parsed);
      current.current = parsed;
    }
  }, [value]);

  const emit = useCallback(
    (next: Color) => {
      setColor(next);
      current.current = next;
      const oklch = next.toOklch();
      lastEmitted.current = oklch;
      onChange(oklch);
    },
    [onChange],
  );

  const suggestionColors = (swatches ?? []).map(swatchColor);
  const isSuggestion = (c: Color) =>
    suggestionColors.some((s) => colorsMatch(s, c.toOklch()));

  /**
   * Settle the current color. `record` adds it to Recent — only for a color
   * the user arrived at, never for a suggestion or the caller's own default.
   */
  const commit = (record: boolean) => {
    const settled = current.current;
    if (
      record &&
      !isSuggestion(settled) &&
      !(defaultValue != null && colorsMatch(defaultValue, settled.toOklch()))
    ) {
      recordUsage(RECENT_USAGE, settled.toHex());
    }
    onCommit?.(settled.toOklch());
  };
  const pick = (next: Color, record: boolean) => {
    emit(next);
    commit(record);
  };
  const edited = () => commit(true);

  const eyeDropper = eyeDropperCtor();
  const valueCss = color.toOklch();
  const atDefault = defaultValue != null && colorsMatch(defaultValue, valueCss);

  return (
    <ControlSizeProvider size="sm">
      <Stack gap="sm" className={cn("w-64 p-sm", className)}>
        {(title != null || defaultValue != null) && (
          <Stack direction="row" gap="sm" align="center">
            {title != null && (
              <BeforeAfter
                before={before}
                after={color}
                onRevert={() => pick(before, false)}
              />
            )}
            <Fill>
              {title != null && (
                <Stack gap="none">
                  <Text variant="label">{title}</Text>
                  <Text variant="caption" tone="muted">
                    {describe(color, swatches ?? [], atDefault)}
                  </Text>
                </Stack>
              )}
            </Fill>
            {defaultValue != null && (
              <IconButton
                icon={resetIcon}
                label="Reset to default"
                disabled={atDefault}
                onClick={() => {
                  const parsed = Color.fromCss(defaultValue);
                  if (!parsed) {
                    throw new Error(
                      `ColorPicker: defaultValue is not a CSS color: ${JSON.stringify(defaultValue)}`,
                    );
                  }
                  pick(parsed, false);
                }}
              />
            )}
          </Stack>
        )}

        {swatches && swatches.length > 0 && (
          <Stack gap="xs">
            <SectionLabel className="px-2xs text-3xs">
              {swatches.some((s) => typeof s !== "string")
                ? "Suggested"
                : "Swatches"}
            </SectionLabel>
            <SwatchGrid
              colors={swatches}
              value={valueCss}
              onChange={(c) => {
                const parsed = Color.fromCss(c);
                if (!parsed) {
                  throw new Error(
                    `ColorPicker: swatch is not a CSS color: ${JSON.stringify(c)}`,
                  );
                }
                pick(parsed, false);
              }}
            />
          </Stack>
        )}

        <Stack gap="sm">
          <ColorArea
            hue={color.h}
            lightness={color.l}
            chroma={color.c}
            onChange={(l, c) =>
              emit(Color.fromOklch(l, c, color.h, color.alpha))
            }
            onCommit={edited}
          />

          <Stack direction="row" gap="sm" align="center">
            {eyeDropper && (
              <IconButton
                icon={eyedropperIcon}
                label="Pick a color from the screen"
                onClick={() => {
                  void new eyeDropper().open().then(
                    (res) => {
                      const parsed = Color.fromCss(res.sRGBHex);
                      if (!parsed) {
                        throw new Error(
                          `ColorPicker: EyeDropper returned a non-color: ${res.sRGBHex}`,
                        );
                      }
                      pick(parsed.withAlpha(current.current.alpha), true);
                    },
                    (err: unknown) => {
                      // Esc / clicking away cancels the pick: nothing to do.
                      if (
                        err instanceof DOMException &&
                        err.name === "AbortError"
                      )
                        return;
                      throw err;
                    },
                  );
                }}
              />
            )}
            <HueSlider
              value={color.h}
              // A hue whose row is narrower pulls chroma onto its edge.
              onChange={(h) => emit(color.withHue(h).fitted())}
              onCommit={edited}
              className="w-full"
            />
          </Stack>

          {showAlpha && (
            <AlphaSlider
              color={color}
              alpha={color.alpha}
              onChange={(a) => emit(color.withAlpha(a))}
              onCommit={edited}
            />
          )}
        </Stack>

        <ColorValueFields
          color={color}
          onChange={emit}
          onCommit={edited}
          showAlpha={showAlpha}
        />

        <RecentColors
          // Without an opacity control the picker never changes alpha.
          onPick={(c) =>
            pick(showAlpha ? c : c.withAlpha(current.current.alpha), true)
          }
        />
      </Stack>
    </ControlSizeProvider>
  );
}

/** What the color is, for the header: a suggestion's name, the default, or custom. */
function describe(
  color: Color,
  swatches: readonly Swatch[],
  atDefault: boolean,
): string {
  const css = color.toOklch();
  const named = swatches.find(
    (s): s is { name: string; color: string } =>
      typeof s !== "string" && colorsMatch(s.color, css),
  );
  if (named) {
    return `${displayName(named.name)} · suggested${atDefault ? ", default" : ""}`;
  }
  return atDefault ? "Default" : "Custom";
}

/**
 * The before · after swatch: left half the color the picker opened with (click
 * it to go back), right half the current one.
 */
function BeforeAfter({
  before,
  after,
  onRevert,
}: {
  before: Color;
  after: Color;
  onRevert: () => void;
}) {
  const same = before.equals(after);
  return (
    <Clip
      className={cn(rigidClass(), "h-7 w-10 rounded-md border border-border")}
    >
      <Stack direction="row" gap="none" className="size-full">
        <WithTooltip content="Back to the color you started with">
          <button
            type="button"
            aria-label="Back to the color you started with"
            disabled={same}
            onClick={onRevert}
            className="h-full w-1/2 disabled:cursor-default"
            style={{ background: before.toOklch() }}
          />
        </WithTooltip>
        <span
          aria-hidden="true"
          className="h-full w-1/2"
          style={{ background: after.toOklch() }}
        />
      </Stack>
    </Clip>
  );
}

/** The colors last committed in any picker, newest first; click one to use it. */
function RecentColors({ onPick }: { onPick: (color: Color) => void }) {
  const recent = useRecentUsage(RECENT_USAGE, RECENT_COUNT);
  return (
    <Stack gap="xs">
      <SectionLabel className="px-2xs text-3xs">Recent</SectionLabel>
      <ResourceView resource={recent} fallback={<Loading variant="text" />}>
        {(keys) =>
          keys.length === 0 ? (
            <Text variant="caption" tone="muted" className="px-2xs">
              Colors you pick show up here.
            </Text>
          ) : (
            <Cluster gap="xs">
              {keys.map((key) => {
                // Every key was recorded from `Color.toHex()`; one that no
                // longer parses is corrupt data, and throws rather than drawing.
                const c = Color.fromCss(key);
                if (!c) {
                  throw new Error(
                    `ColorPicker: recent color is not a color: ${key}`,
                  );
                }
                return (
                  <WithTooltip key={key} content={key}>
                    <button
                      type="button"
                      aria-label={`Recent color ${key}`}
                      onClick={() => onPick(c)}
                      className="size-5 rounded-full border border-border transition-transform hover:scale-110"
                      style={{ background: key }}
                    />
                  </WithTooltip>
                );
              })}
            </Cluster>
          )
        }
      </ResourceView>
    </Stack>
  );
}
