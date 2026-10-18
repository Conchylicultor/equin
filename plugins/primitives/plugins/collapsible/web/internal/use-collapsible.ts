import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { createHoverIntent } from "@plugins/primitives/plugins/overlay/plugins/hover-popover/core";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

export interface UseCollapsibleOptions {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * What makes something the collapsible's trigger, WITHOUT saying what element it
 * is: that it discloses the content, whether that content is open, and what
 * toggles it. Spread onto a component that owns its own host element — `Row`
 * infers `<button>`/`<a>` from its props and stamps the `type` itself, so a
 * caller handing it one is a type error.
 */
export interface CollapsibleTriggerControlProps {
  "aria-expanded": boolean;
  "aria-controls": string;
  onClick: () => void;
}

/**
 * What warms a trigger's content (see `UseCollapsibleReturn.warm`): the
 * pointer resting on the trigger, or focus on it — and, leaving, what lets it
 * go. Part of both trigger bags; a host that composes its own handlers for
 * these events calls them from there (`SectionHeaderRow`).
 */
export interface CollapsibleWarmHandlers {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

/**
 * What makes a box the collapsible's content: the open state it folds on, and
 * the id / `region` role the trigger's `aria-controls` points at. Spread onto
 * `<FoldMotion>` — the content is never `{open && …}`, which drops the motion.
 */
export interface CollapsibleContentBindProps {
  open: boolean;
  warm: boolean;
  id: string;
  role: "region";
}

export interface UseCollapsibleReturn {
  /** For the trigger's chrome (a chevron, a label) — never to gate the
   *  content: that is `contentProps` on a `<FoldMotion>`. */
  open: boolean;
  toggle: () => void;
  /**
   * Mount the content (hidden) while closed: true while the pointer has
   * rested on the trigger for {@link WARM_INTENT_MS}, or focus is on it — so
   * the click that opens it does not first pay for mounting what it reveals.
   * A pointer sweeping past never warms (no mount per header it crosses), and
   * leaving lets it go, so at most the section under the pointer is mounted
   * while closed. `warmHandlers` drive it; the trigger bags carry them.
   */
  warm: boolean;
  warmHandlers: CollapsibleWarmHandlers;
  /** {@link CollapsibleTriggerControlProps} — for a host that owns its element. */
  triggerControlProps: CollapsibleTriggerControlProps & CollapsibleWarmHandlers;
  /**
   * The same semantics for a RAW `<button>` you render yourself, plus the
   * `type="button"` that keeps it from submitting a surrounding form. Derived
   * from `triggerControlProps` rather than written beside it, so the two can
   * never disagree about what the trigger does.
   */
  triggerProps: CollapsibleTriggerControlProps &
    CollapsibleWarmHandlers & { type: "button" };
  /**
   * {@link CollapsibleContentBindProps} — spread onto `<FoldMotion>` so the
   * content folds with motion: `<FoldMotion {...contentProps}>…</FoldMotion>`.
   */
  contentProps: CollapsibleContentBindProps;
  contentId: string;
  chevronClassName: ClassName;
}

/** How long the pointer rests on a trigger before its content warms. */
const WARM_INTENT_MS = 100;

export function useCollapsible({
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
}: UseCollapsibleOptions = {}): UseCollapsibleReturn {
  const contentId = useId();
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = isControlled ? controlledOpen : internalOpen;

  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const warm = hovered || focused;
  const intent = useMemo(
    () =>
      createHoverIntent({
        openDelay: WARM_INTENT_MS,
        closeDelay: 0,
        onOpen: () => setHovered(true),
        onClose: () => setHovered(false),
      }),
    [],
  );
  useEffect(() => () => intent.cancel(), [intent]);
  const warmHandlers = useMemo<CollapsibleWarmHandlers>(
    () => ({
      onPointerEnter: () => intent.enter(),
      onPointerLeave: () => intent.leave(),
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    }),
    [intent],
  );

  const toggle = useCallback(() => {
    const next = !open;
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }, [open, isControlled, onOpenChange]);

  return useMemo(() => {
    const triggerControlProps = {
      "aria-expanded": open,
      "aria-controls": contentId,
      onClick: toggle,
      ...warmHandlers,
    };
    return {
      open,
      toggle,
      warm,
      warmHandlers,
      triggerControlProps,
      triggerProps: { type: "button" as const, ...triggerControlProps },
      contentProps: { open, warm, id: contentId, role: "region" as const },
      contentId,
      chevronClassName: cn(
        "transition-transform duration-200",
        open && "rotate-90",
      ),
    };
  }, [open, toggle, warm, warmHandlers, contentId]);
}
