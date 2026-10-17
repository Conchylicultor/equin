import { Icon } from "@plugins/ui/plugins/icons/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { TooltipDoc } from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { pillHighlightClass } from "@plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill/web";

export interface ComposerAttachButtonProps {
  icon: IconRef;
  /**
   * What is attached ("Page URL") — the pill's text while on, and the
   * tooltip title and accessible name in both states.
   */
  label: string;
  active: boolean;
  onToggle: (next: boolean) => void;
  /**
   * What attaching does, shown under the label in the hover tooltip. Required:
   * the bare icon it is while off says nothing to a new user on its own.
   */
  description: string;
  disabled?: boolean;
}

/**
 * An attach toggle on the composer's bar — "Page URL" and its kin — sitting
 * beside the bar's other context actions (the element picker).
 *
 * Off, it is a bare icon, like every bar control left on its default: an
 * unattached thing should take no room. On, it becomes a filled pill naming
 * what is attached, in the same highlight a set `PickerPill` wears — so
 * the bar reads what will go with the prompt at a glance.
 */
export function ComposerAttachButton({
  icon,
  label,
  active,
  onToggle,
  description,
  disabled,
}: ComposerAttachButtonProps) {
  return (
    <Button
      tooltip={<TooltipDoc title={label}>{description}</TooltipDoc>}
      shape="pill"
      aspect={active ? "text" : "icon"}
      variant={active ? "frame" : "ghost"}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onToggle(!active)}
      className={cn(active && pillHighlightClass)}
    >
      <Icon icon={icon} aria-hidden className="size-3.5" />
      {active && <Text variant="control">{label}</Text>}
    </Button>
  );
}
