import {
  cn,
  type ControlSize,
  type DensityControlled,
  type Tooltipped,
  useControlSize,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { Passthrough } from "@plugins/primitives/plugins/passthrough/core";
import type React from "react";

export type ToggleChipVariant = "solid" | "ghost" | "tinted" | "outline";
export type ToggleChipSize = "sm" | "md";

// The chip's two-level scale sits one notch under the control scale by design
// (chips read slightly smaller than the buttons beside them): "sm" → control-xs,
// "md" → control-sm. Map the ambient 4-level density onto it so an unsized chip in
// a toolbar matches a same-density button's height as closely as the scale allows
// (`sm` density → "md" → control-sm = a `sm` button). Above `sm` it caps at "md".
function chipSizeForDensity(density: ControlSize): ToggleChipSize {
  return density === "xs" ? "sm" : "md";
}

// The off state `solid` and `tinted` share: a chip that reads as an outlined
// control whichever colour its on state wears. One spelling, so the two cannot
// drift into looking like different buttons while switched off.
const BORDERED_OFF =
  "border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground";

const VARIANT_CLASS: Record<
  ToggleChipVariant,
  { active: string; inactive: string }
> = {
  // stats look: filled primary when on, bordered background when off
  solid: {
    active: "border border-primary bg-primary text-primary-foreground",
    inactive: BORDERED_OFF,
  },
  // filter look: accent fill when on, transparent ghost when off
  ghost: {
    active: "bg-accent text-accent-foreground",
    inactive: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
  },
  // attach look: the SAME bordered chip when off as `solid`, tinted rather than
  // filled when on — the accent arrives as a wash, a line and the label's
  // colour instead of as a block of primary. For a chip that sits in a row of
  // its own kind and is toggled often, where a solid fill reads as an alert.
  // Both states carry one `border`, so switching it on cannot move its
  // neighbours by a pixel.
  tinted: {
    active: "border border-primary/40 bg-primary/10 text-primary-text",
    inactive: BORDERED_OFF,
  },
  // pill-row look: a hairline-outlined pill on whatever is behind it when off,
  // the inverted fill (`secondary`) when on — a row of category pills on a
  // designed page, where the selected one reads as the solid one. Both states
  // carry one `border`, so switching cannot move the neighbours.
  outline: {
    active: "border border-secondary bg-secondary text-secondary-foreground",
    inactive:
      "border border-foreground/16 text-muted-foreground hover:border-foreground/30 hover:text-foreground",
  },
};

/**
 * A toggle chip IS a `Badge`, so its passthrough lands where Badge's does — the
 * chip shell, never the truncating label span inside it. See
 * {@link Passthrough}.
 */
export interface ToggleChipProps
  extends DensityControlled, Tooltipped, Passthrough {
  /** Whether the chip reads as selected/on. Drives the active vs inactive color pair. */
  active: boolean;
  /**
   * Color treatment. "solid" = filled-primary when on, bordered when off
   * (controls); "ghost" = accent fill when on, transparent when off (filters);
   * "tinted" = accent wash + accent line + accent label when on, bordered when
   * off (attach toggles); "outline" = inverted fill when on, a transparent
   * outlined pill when off (category pills on a designed page). Default "solid".
   */
  variant?: ToggleChipVariant;
  /** Leading icon, rendered before children. */
  icon?: React.ReactNode;
  /** Element to render. Default "button"; pass "a" for link-style chips. */
  as?: React.ElementType;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function ToggleChip({
  active,
  variant = "solid",
  icon,
  as: As = "button",
  disabled,
  className,
  children,
  ...rest
}: ToggleChipProps) {
  // Size is inherited from the ambient density (defaults to "md" → "md").
  const density = useControlSize();
  const effectiveSize = chipSizeForDensity(density);
  const isButton = As === "button";
  // Auto toggle semantics for plain buttons; defer to the caller's role
  // (e.g. SegmentedControl's role="radio" + aria-checked) when one is supplied.
  const ariaPressed = isButton && rest.role === undefined ? active : undefined;
  return (
    <Badge
      as={As}
      shape="pill"
      icon={icon}
      colorClass={
        active ? VARIANT_CLASS[variant].active : VARIANT_CLASS[variant].inactive
      }
      type={isButton ? "button" : undefined}
      disabled={isButton ? disabled : undefined}
      aria-pressed={ariaPressed}
      // eslint-disable-next-line control-size/no-adhoc-density -- ToggleChip IS the density-deriving primitive: control-xs/control-sm here is the height it maps from ambient density (chipSizeForDensity), applied to the composed Badge shell — not a per-instance consumer override.
      className={cn(
        // ToggleChip's identity over the shared chip shell: a control that
        // matches the buttons beside it — at `md`, the small button's height,
        // inline padding and gap — with hover/disabled transitions.
        "transition-colors disabled:pointer-events-none disabled:opacity-50",
        effectiveSize === "sm" && "control-xs p-chip text-2xs",
        effectiveSize === "md" &&
          "control-sm px-control-sm gap-control-sm text-caption",
        className,
      )}
      {...rest}
    >
      {children}
    </Badge>
  );
}

/**
 * One segment. Either LABELLED — its visible label names it (an icon and a
 * tooltip are extras) — or ICON-ONLY: no label, an icon, and a plain-string
 * `tooltip` that is both its hover tip and its accessible name (Button's
 * icon-only rule), so a nameless radio has no spelling.
 */
export type SegmentedOption<T extends string> = {
  id: T;
  /**
   * A count drawn after the label as a filled pill (a tab's unread messages).
   * Absent ⇒ no badge; `0` is drawn — a caller with nothing to count omits it.
   */
  count?: number;
} & (
  | {
      label: Exclude<React.ReactNode, undefined | null | boolean>;
      icon?: React.ReactNode;
      tooltip?: React.ReactNode;
    }
  | { label?: never; icon: React.ReactNode; tooltip: string }
);

/**
 * The accessible name an option's radio takes beyond its own text: the
 * icon-only arm's tooltip. A labelled arm whose label is `""` would be a
 * nameless radio the union cannot see (`""` is a string), so it throws.
 */
function iconOnlyName<T extends string>(
  opt: SegmentedOption<T>,
): string | undefined {
  if (opt.label === undefined) return opt.tooltip;
  if (opt.label === "")
    throw new Error(
      `SegmentedControl option "${opt.id}" has an empty label: omit \`label\` and give an icon-only option a string \`tooltip\` (its accessible name).`,
    );
  return undefined;
}

/**
 * A segmented control's look: one of the chip colour treatments (each segment a
 * `ToggleChip`), or `"underline"` — a tab strip: bare segments on one hairline,
 * the selected one in the foreground over a 2px underline sitting ON that
 * hairline (a page's section tabs, where pills would read as filters).
 */
export type SegmentedVariant = ToggleChipVariant | "underline";

export interface SegmentedControlProps<
  T extends string,
> extends DensityControlled {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** The segments' look (see {@link SegmentedVariant}). Default "solid". */
  variant?: SegmentedVariant;
  /** Wrapper override (e.g. spacing). */
  className?: string;
  /** The group's accessible name (its visible heading, when it has one). */
  label?: string;
}

/** The count pill a segment carries after its label. */
function CountBadge({ count }: { count: number }) {
  return (
    <Badge shape="pill" colorClass="bg-primary text-primary-foreground">
      {count}
    </Badge>
  );
}

// The underline tab's height sits one notch ABOVE the control scale (a tab strip
// heads a page section, so it reads taller than the buttons in it): xs → sm,
// sm → md, md/lg → lg.
const UNDERLINE_TAB_SIZE: Record<ControlSize, string> = {
  xs: "control-sm px-control-xs gap-control-xs",
  sm: "control-md px-control-sm gap-control-sm",
  md: "control-lg px-control-md gap-control-sm",
  lg: "control-lg px-control-md gap-control-md",
};

interface UnderlineTabProps {
  active: boolean;
  icon: React.ReactNode;
  label: React.ReactNode;
  count: number | undefined;
  tooltip: React.ReactNode;
  ariaLabel: string | undefined;
  onSelect: () => void;
}

/**
 * One segment of the underline strip: icon · label · count on one line, muted
 * until selected; the selected tab's underline is a decorative bar pulled 1px
 * down onto the strip's hairline (so the two read as one rule), inset from the
 * tab's edges. A child element, not `::after`: control lint reads a pseudo's
 * `after:h-* after:rounded-*` as the button's own geometry.
 */
function UnderlineTab({
  active,
  icon,
  label,
  count,
  tooltip,
  ariaLabel,
  onSelect,
}: UnderlineTabProps) {
  const density = useControlSize();
  return (
    <WithTooltip content={tooltip}>
      <button
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={ariaLabel}
        onClick={onSelect}
        className={cn(
          "relative inline-flex shrink-0 items-center whitespace-nowrap transition-colors",
          UNDERLINE_TAB_SIZE[density],
          active
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {icon}
        {label != null && <Text variant="control">{label}</Text>}
        {count !== undefined && <CountBadge count={count} />}
        {active && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-foreground"
          />
        )}
      </button>
    </WithTooltip>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  variant = "solid",
  className,
  label,
}: SegmentedControlProps<T>) {
  if (variant === "underline") {
    return (
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(
          "flex shrink-0 flex-nowrap gap-2xs border-b border-border",
          className,
        )}
      >
        {options.map((opt) => (
          <UnderlineTab
            key={opt.id}
            active={opt.id === value}
            icon={opt.icon}
            label={opt.label}
            count={opt.count}
            tooltip={opt.tooltip}
            ariaLabel={iconOnlyName(opt)}
            onSelect={() => onChange(opt.id)}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("flex shrink-0 flex-nowrap gap-xs", className)}
    >
      {options.map((opt) => (
        <ToggleChip
          key={opt.id}
          role="radio"
          aria-checked={opt.id === value}
          active={opt.id === value}
          variant={variant}
          icon={opt.icon}
          tooltip={opt.tooltip}
          aria-label={iconOnlyName(opt)}
          onClick={() => onChange(opt.id)}
        >
          {opt.label ?? null}
          {opt.count !== undefined && <CountBadge count={opt.count} />}
        </ToggleChip>
      ))}
    </div>
  );
}
