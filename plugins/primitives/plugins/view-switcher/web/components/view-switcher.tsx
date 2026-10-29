import { Icon } from "@plugins/ui/plugins/icons/web";
import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ReactNode } from "react";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";

export interface ViewSwitcherOption {
  id: string;
  title: string;
  icon: IconRef;
  /** A count drawn after the title as a filled pill (unread messages). Absent ⇒ none. */
  count?: number;
}

/**
 * The switcher's look: `"pill"` (default) — borderless ghost pills, the Notion
 * view bar; `"underline"` — a tab strip on a hairline, the selected tab
 * underlined (a page's section tabs).
 */
export type ViewSwitcherVariant = "pill" | "underline";

export interface ViewSwitcherProps {
  options: readonly ViewSwitcherOption[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Default `"pill"`. */
  variant?: ViewSwitcherVariant;
  className?: string;
}

/**
 * Presentational view-switcher chrome: borderless ghost pills (the Notion look,
 * `SegmentedControl variant="ghost"`) or an underline tab strip
 * (`variant="underline"`). Pure chrome — no localStorage, no
 * slots, no config; selection state stays with the caller. Renders nothing when
 * there is one option or fewer.
 */
export function ViewSwitcher({
  options,
  activeId,
  onSelect,
  variant = "pill",
  className,
}: ViewSwitcherProps): ReactNode {
  if (options.length <= 1) return null;

  return (
    <SegmentedControl
      options={options.map((opt) => ({
        id: opt.id,
        label: opt.title,
        icon: (
          <Icon
            icon={opt.icon}
            active={opt.id === activeId}
            className="size-3.5"
          />
        ),
        count: opt.count,
      }))}
      value={activeId}
      onChange={onSelect}
      variant={variant === "pill" ? "ghost" : "underline"}
      className={className}
    />
  );
}
