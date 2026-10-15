import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCallback, useId, useMemo, useState } from "react";

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
 * What makes a box the collapsible's content: the open state it folds on, and
 * the id / `region` role the trigger's `aria-controls` points at. Spread onto
 * `<FoldMotion>` — the content is never `{open && …}`, which drops the motion.
 */
export interface CollapsibleContentBindProps {
  open: boolean;
  id: string;
  role: "region";
}

export interface UseCollapsibleReturn {
  /** For the trigger's chrome (a chevron, a label) — never to gate the
   *  content: that is `contentProps` on a `<FoldMotion>`. */
  open: boolean;
  toggle: () => void;
  /** {@link CollapsibleTriggerControlProps} — for a host that owns its element. */
  triggerControlProps: CollapsibleTriggerControlProps;
  /**
   * The same semantics for a RAW `<button>` you render yourself, plus the
   * `type="button"` that keeps it from submitting a surrounding form. Derived
   * from `triggerControlProps` rather than written beside it, so the two can
   * never disagree about what the trigger does.
   */
  triggerProps: CollapsibleTriggerControlProps & { type: "button" };
  /**
   * {@link CollapsibleContentBindProps} — spread onto `<FoldMotion>` so the
   * content folds with motion: `<FoldMotion {...contentProps}>…</FoldMotion>`.
   */
  contentProps: CollapsibleContentBindProps;
  contentId: string;
  chevronClassName: ClassName;
}

export function useCollapsible({
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
}: UseCollapsibleOptions = {}): UseCollapsibleReturn {
  const contentId = useId();
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = isControlled ? controlledOpen : internalOpen;

  const toggle = useCallback(() => {
    const next = !open;
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }, [open, isControlled, onOpenChange]);

  return useMemo(() => {
    const triggerControlProps: CollapsibleTriggerControlProps = {
      "aria-expanded": open,
      "aria-controls": contentId,
      onClick: toggle,
    };
    return {
      open,
      toggle,
      triggerControlProps,
      triggerProps: { type: "button" as const, ...triggerControlProps },
      contentProps: { open, id: contentId, role: "region" as const },
      contentId,
      chevronClassName: cn(
        "transition-transform duration-200",
        open && "rotate-90",
      ),
    };
  }, [open, toggle, contentId]);
}
