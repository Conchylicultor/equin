import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { useRef, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  Row,
  SectionHeaderRow,
} from "@plugins/primitives/plugins/css/plugins/row/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import {
  Stack,
  selfClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Color } from "@plugins/primitives/plugins/css/plugins/color-picker/core";
import { ColorPickerPopover } from "@plugins/primitives/plugins/css/plugins/color-picker/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  FillFromMenu,
  useTokenGroupEditor,
} from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import {
  DEFAULT_SHADOW_PARAMS,
  shadowFragment,
  shadowGroup,
  shadowParamsOf,
  type ShadowParams,
} from "../../core";
import { shadowShortcuts } from "../shortcuts";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const undoIcon = symbol("undo");

function channelsToOklch(channels: string): string {
  return `oklch(${channels})`;
}

function oklchToChannels(oklchCss: string): string | null {
  const color = Color.fromCss(oklchCss);
  if (!color) return null;
  const l = Math.round(color.l * 1000) / 1000;
  const c = Math.round(color.c * 1000) / 1000;
  const h = Math.round(color.h * 10) / 10;
  return `${l} ${c} ${h}`;
}

type ParamKey = keyof ShadowParams;

const PARAM_FIELDS: {
  key: Exclude<ParamKey, "color">;
  label: string;
}[] = [
  { key: "opacity", label: "Opacity" },
  { key: "blur", label: "Blur" },
  { key: "spread", label: "Spread" },
  { key: "offsetX", label: "Offset X" },
  { key: "offsetY", label: "Offset Y" },
];

function ResetButton({
  isOverridden,
  onReset,
}: {
  isOverridden: boolean;
  onReset: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onReset}
      title="Reset to the inherited value"
      className={cn(
        rigidClass(),
        "text-muted-foreground hover:text-foreground transition-opacity",
        isOverridden
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-30 pointer-events-none",
      )}
      aria-hidden={!isOverridden}
    >
      <Icon icon={undoIcon} className="size-3.5" />
    </button>
  );
}

function ParamInput({
  paramKey,
  value,
  isOverridden,
  onCommit,
  onReset,
}: {
  paramKey: Exclude<ParamKey, "color">;
  value: string | number;
  isOverridden: boolean;
  onCommit: (value: string | number) => void;
  onReset: () => void;
}) {
  const [localValue, setLocalValue] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mirror the incoming value into the local draft unless the user is editing
  // (focus tracked as state — reading inputRef.current during render is a
  // react-hooks/refs violation). inputRef is still used by onKeyDown to blur.
  if (String(value) !== localValue && !focused) {
    setLocalValue(String(value));
  }

  const commit = () => {
    if (localValue === String(value)) return;
    if (paramKey === "opacity") {
      const opacity = Number(localValue);
      // Not a number: nothing to write; the draft snaps back to the value.
      if (Number.isNaN(opacity)) {
        setLocalValue(String(value));
        return;
      }
      onCommit(opacity);
      return;
    }
    onCommit(localValue);
  };

  return (
    <Line className="gap-sm group">
      <input
        ref={inputRef}
        type="text"
        className={cn(
          fillClasses("x"),
          "text-caption font-mono bg-transparent border border-transparent rounded-md px-xs py-2xs focus:border-border focus:bg-background focus:outline-none",
        )}
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") inputRef.current?.blur();
        }}
      />
      <ResetButton isOverridden={isOverridden} onReset={onReset} />
    </Line>
  );
}

function sameParams(a: ShadowParams, b: ShadowParams): boolean {
  return (Object.keys(a) as ParamKey[]).every((k) => a[k] === b[k]);
}

/**
 * The shadow group is edited through six params, never tier by tier: every
 * tier is derived from them (`buildShadowTiers`), and a fragment the editor
 * writes stores the params in its `meta` so they can be edited again. A theme
 * whose shadow tiers came without params (a tweakcn import) shows the default
 * params, and the first change replaces its tiers.
 *
 * `search` is unused: whether this section appears at all is the
 * contribution's `useAvailable`, and the body lists every shadow token.
 */
export function ShadowSection() {
  const editor = useTokenGroupEditor(shadowGroup);
  if (editor.pending) {
    if (editor.error !== null) {
      return (
        <ResourceErrorInline
          error={editor.error}
          refetch={editor.refetch}
          variant="block"
          subject="the theme selection"
        />
      );
    }
    return <Loading variant="rows" count={6} />;
  }

  // The params the scope shows if its own shadow edit were cleared, and the
  // params of that edit (undefined when the scope has none).
  const inheritedParams =
    shadowParamsOf(editor.inheritedMeta) ?? DEFAULT_SHADOW_PARAMS;
  const ownParams = shadowParamsOf(editor.own?.meta);
  const params = ownParams ?? inheritedParams;
  const hasOwnShadow = editor.own !== undefined;

  // Clears the scope's own shadow fragment, so the inherited tiers show again.
  const resetAll = () =>
    editor.fillFrom({ groupId: shadowGroup.id, light: {}, dark: {} });

  const setParam = <K extends ParamKey>(key: K, value: ShadowParams[K]) => {
    const next = { ...params, [key]: value };
    if (sameParams(next, inheritedParams)) resetAll();
    else editor.fillFrom(shadowFragment(next));
  };

  const isOverridden = (key: ParamKey) =>
    ownParams !== undefined && ownParams[key] !== inheritedParams[key];

  const schema = shadowGroup.schema;
  const allKeys = Object.keys(schema) as (keyof typeof schema)[];
  const tiers = editor.values.light;

  return (
    <Stack gap="xs">
      <FillFromMenu
        shortcuts={shadowShortcuts}
        onFill={(shortcut) => editor.fillFrom(shortcut.fragment)}
      />

      {/* Parameters editor */}
      <Collapsible defaultOpen>
        <SectionHeaderRow variant="eyebrow">Parameters</SectionHeaderRow>
        <CollapsibleContent className="pl-sm pt-xs">
          <Stack gap="xs">
            {/* Color row */}
            <Row className="gap-sm">
              <Text
                as="span"
                variant="label"
                className={cn("w-16", rigidClass())}
              >
                Color
              </Text>
              <Stack
                direction="row"
                gap="sm"
                align="center"
                className={fillClasses("x")}
              >
                <ColorPickerPopover
                  value={channelsToOklch(params.color)}
                  onChange={(oklch) => {
                    const channels = oklchToChannels(oklch);
                    if (channels) setParam("color", channels);
                  }}
                />
                <Text
                  as="span"
                  variant="caption"
                  className="font-mono text-muted-foreground"
                >
                  {params.color}
                </Text>
              </Stack>
              <ResetButton
                isOverridden={isOverridden("color")}
                onReset={() => setParam("color", inheritedParams.color)}
              />
            </Row>

            {/* Numeric/text param rows */}
            {/* eslint-disable-next-line data-view/no-adhoc-row-list -- fixed token-editor param rows, not domain records */}
            {PARAM_FIELDS.map(({ key, label }) => (
              <Row key={key} className="gap-sm">
                <Text
                  as="span"
                  variant="label"
                  className={cn("w-16", rigidClass())}
                >
                  {label}
                </Text>
                <ParamInput
                  paramKey={key}
                  value={params[key]}
                  isOverridden={isOverridden(key)}
                  onCommit={(value) =>
                    setParam(
                      key,
                      key === "opacity" ? Number(value) : String(value),
                    )
                  }
                  onReset={() => setParam(key, inheritedParams[key])}
                />
              </Row>
            ))}

            {hasOwnShadow && (
              <Button
                variant="ghost"
                className={cn(
                  selfClass("start"),
                  "border border-border text-muted-foreground",
                )}
                onClick={resetAll}
              >
                Reset all
              </Button>
            )}
          </Stack>
        </CollapsibleContent>
      </Collapsible>

      {/* Token previews */}
      <Collapsible>
        <SectionHeaderRow variant="eyebrow">Preview</SectionHeaderRow>
        <CollapsibleContent className="pl-sm pt-xs">
          <Cluster gap="md" className="p-sm">
            {allKeys.map((key) => {
              const label = schema[key]?.label ?? (key as string);
              return (
                <Stack key={key as string} align="center" gap="xs">
                  <span
                    className="size-8 rounded-md bg-background border border-border"
                    style={{ boxShadow: tiers[key] }}
                  />
                  <span className="text-3xs text-muted-foreground text-center max-w-12">
                    {label.replace("Shadow ", "")}
                  </span>
                </Stack>
              );
            })}
          </Cluster>
        </CollapsibleContent>
      </Collapsible>
    </Stack>
  );
}
