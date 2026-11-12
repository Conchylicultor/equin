import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web/lib/utils";

/**
 * The plain rule: a full-width (or full-height) hairline, no content.
 * `label` is spelled here as `never` so the two forms discriminate.
 */
type PlainSeparatorProps =
  | (SeparatorPrimitive.Props & { label?: undefined; bleed?: false })
  | (Omit<SeparatorPrimitive.Props, "orientation"> & {
      label?: undefined;
      /**
       * Run the hairline through the region's rail to its edge (`rail-bleed`)
       * — the rule between a menu's search and its rows, inside any padded
       * host — with a menu separator's room on both sides (`my-menu-separator`),
       * so a hovered row never touches it. Horizontal only (a vertical bleed is a type error), and it drops
       * the plain rule's `w-full`: a width class beside `rail-bleed` would
       * cancel its widening (the rail contract's known gap), stopping the line
       * one rail short of the edge it claims to reach.
       */
      bleed: true;
      orientation?: "horizontal";
    });

/**
 * The labelled rule: a centered muted caption with the hairline growing to fill
 * the space on either side of it — the "3 commits on main" / "Theme" divider
 * three surfaces used to hand-roll out of two `h-px grow bg-border` divs.
 *
 * It takes plain `div` props rather than the primitive's, because it is not the
 * primitive: base-ui's separator is an empty box, and a rule with content in the
 * middle of it is a different element. `orientation` is fixed to `horizontal` —
 * a vertical rule has no room for a label, so that combination is a type error
 * rather than something that renders wrong.
 */
type LabelledSeparatorProps = Omit<
  React.ComponentPropsWithoutRef<"div">,
  "children" | "role" | "aria-label"
> & {
  /** The centered text. Also the rule's accessible name (see below). */
  label: string;
  orientation?: "horizontal";
};

export type SeparatorProps = PlainSeparatorProps | LabelledSeparatorProps;

function Separator(props: SeparatorProps) {
  if (props.label !== undefined) {
    const { label, className, orientation: _orientation, ...rest } = props;
    return (
      <div
        data-slot="separator"
        role="separator"
        aria-orientation="horizontal"
        // A `separator`'s children are presentational (per ARIA) and its name
        // comes from the author, so the visible text alone would be announced
        // to nobody. Naming the rule with the same string is what makes the
        // label reach assistive tech, exactly once.
        aria-label={label}
        className={cn("flex w-full shrink-0 items-center gap-sm", className)}
        {...rest}
      >
        {/* eslint-disable-next-line control-panel/no-adhoc-panel-body -- this IS the divider recipe the rule redirects to; the flanking rules of the labelled form are drawn here so no caller draws them */}
        <span className="h-px grow bg-border" />
        <span className="text-caption text-muted-foreground">{label}</span>
        {/* eslint-disable-next-line control-panel/no-adhoc-panel-body -- second half of the same rule; see above */}
        <span className="h-px grow bg-border" />
      </div>
    );
  }

  const {
    className,
    orientation = "horizontal",
    label: _label,
    bleed = false,
    ...rest
  } = props;
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={bleed ? "horizontal" : orientation}
      className={cn(
        bleed
          ? "shrink-0 bg-border data-horizontal:h-px rail-bleed my-menu-separator"
          : "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className,
      )}
      {...rest}
    />
  );
}

export { Separator };
