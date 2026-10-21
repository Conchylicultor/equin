import {
  IconButton,
  type IconButtonProps,
} from "@plugins/primitives/plugins/icon-button/web";
import { TooltipDoc } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import type { UiContextMeta } from "@plugins/primitives/plugins/ui-context/core";
import { formatShortcutLabel } from "@plugins/primitives/plugins/shortcuts/web";
import { ElementPicker } from "./element-picker";
import { symbol } from "@plugins/ui/plugins/icons/core";

const adsClickIcon = symbol("ads-click");

/**
 * The bare "pick a UI element" affordance: an icon button that arms the
 * inspector overlay and reports the picked element's metadata. Call sites differ
 * only in what they do with the meta (open the Improve popover vs. inject a chip
 * into the draft form), so the button itself stays agnostic.
 */
export function PickerButton({
  onPick,
  label = "Pick UI element",
  description = `Click an element to attach it as context. ${formatShortcutLabel("mod")}-click to use the app, Esc to stop.`,
  variant,
}: {
  onPick: (meta: UiContextMeta) => void;
  label?: string;
  /**
   * How to pick, under the label in the hover tooltip — the only place it is
   * said: the armed overlay draws no instructions over the page.
   */
  description?: string;
  /** The button's look — ghost by default; `frame` as a segment of a split pill. */
  variant?: IconButtonProps["variant"];
}) {
  return (
    <ElementPicker
      onPick={onPick}
      trigger={({ armed, arm }) => (
        // Disabled while picking — and therefore `pointer-events:none`, i.e. NOT
        // hit-testable. That is deliberate: `resolveTarget` resolves elements the
        // browser's hit test skips, so this button doubles as the live regression
        // test for that (the e2e picks it every run). Do not "fix" a failed pick
        // here by dropping `disabled` — the bug would be in resolve-target.ts.
        <IconButton
          icon={adsClickIcon}
          label={label}
          tooltip={<TooltipDoc title={label}>{description}</TooltipDoc>}
          variant={variant}
          disabled={armed}
          onClick={arm}
        />
      )}
    />
  );
}
