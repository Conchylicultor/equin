import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { IconPicker } from "@plugins/primitives/plugins/icon-picker/web";
import type { SavedSymbolName } from "@plugins/ui/plugins/icons/core";
import type { BlockEditorAPI } from "@plugins/page/plugins/editor/web";
import { calloutBlock, CALLOUT_COLORS, type CalloutColor } from "../../core";

/** Solid swatch dot per semantic color, shown in the color row of the popover. */
const COLOR_SWATCH: Record<CalloutColor, string> = {
  default: "bg-muted-foreground/40",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

export interface CalloutIconChange {
  icon: SavedSymbolName | null;
  color: CalloutColor;
}

/** The callout's appearance, read defensively — `data` can be transient mid-edit. */
export function readCalloutAppearance(data: unknown): CalloutIconChange {
  const parsed = calloutBlock.safeParse(data);
  if (parsed.success) return parsed.data;
  // An unparseable payload still gets a glyph, just the default one — exactly as
  // `CalloutFrame` still paints a box in the default tint.
  return { icon: null, color: "default" };
}

/**
 * The callout's appearance controls bound to one block's payload and API — the
 * ONE wiring of `data → controls → api.update`, shared by the two surfaces that
 * offer appearance: the glyph's own popover (`CalloutAnchor`) and the rail's
 * block-actions menu (`CalloutMenu`). Appearance being reachable from both is
 * deliberate; having it wired twice would not be.
 *
 * `update` carries the WHOLE payload, not just the changed key: `BlockEditorAPI`
 * replaces a block's `data` rather than merging into it.
 */
export function CalloutAppearanceFor({
  data,
  api,
  close,
}: {
  data: unknown;
  api: BlockEditorAPI;
  close: () => void;
}) {
  const { icon, color } = readCalloutAppearance(data);
  return (
    <CalloutAppearance
      color={color}
      icon={icon}
      onChange={(next) => api.update({ icon, color, ...next })}
      close={close}
    />
  );
}

/**
 * The callout's own appearance controls, rendered by `ContainerAnchor` above the
 * shared structural actions: colour swatches, the icon picker, and Reset.
 *
 * This is the whole of what is callout-SPECIFIC about its anchor menu — the
 * container primitive owns the trigger, the popover and the Remove/Delete
 * actions, and a container with no per-instance appearance (the context card)
 * simply contributes no sections at all.
 *
 * `close` is the shell's dismiss: the popover's open state belongs to
 * `ContainerAnchor`, so a control that commits and should dismiss says so rather
 * than owning a second copy of that state. The swatches deliberately do NOT
 * close — picking colours in a row is a comparison, not a commit.
 */
export function CalloutAppearance({
  color,
  icon,
  onChange,
  close,
}: {
  color: CalloutColor;
  icon: SavedSymbolName | null;
  onChange: (next: Partial<CalloutIconChange>) => void;
  close: () => void;
}) {
  return (
    <>
      <ControlPanel.Section label="Color">
        <Stack direction="row" gap="xs" wrap>
          {CALLOUT_COLORS.map((key) => (
            <button
              key={key}
              type="button"
              aria-label={key}
              aria-pressed={color === key}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange({ color: key })}
              className={cn(
                "size-5 rounded-full border border-border transition-transform",
                COLOR_SWATCH[key],
                color === key &&
                  "scale-110 ring-2 ring-ring ring-offset-1 ring-offset-background",
              )}
            />
          ))}
        </Stack>
      </ControlPanel.Section>

      {/* The picker draws its own "Icon" heading, so this band takes no label. */}
      <ControlPanel.Section needs="picker">
        <IconPicker
          value={icon}
          onSelect={(name) => {
            onChange({ icon: name });
            close();
          }}
        />
      </ControlPanel.Section>

      {/* Reset is a band of its own, so the rule above it is the panel's — the
          hand-drawn `h-px bg-border` this file used to place is gone. It is NOT
          a `Footer`: these sections also render as the top half of the rail's
          block-actions panel, where a sticky footer in the middle of the panel
          would pin over the structural actions below it. */}
      <ControlPanel.Section>
        <ControlPanel.Row
          muted
          onSelect={() => {
            onChange({ icon: null, color: "default" });
            close();
          }}
        >
          Reset
        </ControlPanel.Row>
      </ControlPanel.Section>
    </>
  );
}
