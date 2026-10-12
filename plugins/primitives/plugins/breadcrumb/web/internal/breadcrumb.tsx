import { Fragment, useRef, type ReactNode } from "react";
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { TrailSeparator } from "./trail-separator";
import { useAncestorCollapse } from "./use-ancestor-collapse";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";

const moreHorizIcon = symbol("more-horiz");

export interface BreadcrumbSegment {
  key: string;
  label: ReactNode;
  /**
   * What activating this crumb does — omit it and the crumb is plain text (the
   * leaf ignores it: it is where you already are).
   *
   * An {@link Activation}, not an `onNavigate` callback on the trail, so a
   * crumb that goes to a PLACE can say where: hand it a `LinkTarget`
   * (`openPane.to(…)`) and ⌘/Ctrl- and middle-click open that place in a new
   * browser tab, from the crumb and from the folded menu alike. A plain
   * function is for a trail that moves local state no URL names (a folder
   * picker's browse path).
   */
  activation?: Activation;
}

export interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
  actions?: ReactNode;
  /**
   * The weight the current page's name is set in. `medium` (the default) lets
   * weight alone single the leaf out; `semibold` makes it read as the title of
   * the place (a file browser's current folder); `normal` leaves that to its
   * colour — the strong tier against muted ancestors — for a trail drawn in one
   * weight.
   */
  leafWeight?: "medium" | "semibold" | "normal";
  /**
   * The current page's name's colour. `inherit` (the default) takes the colour
   * of whatever hosts the trail; `strong` sets it in the strong text tier, so a
   * theme that keeps body text a step below titles still reads the leaf as the
   * title it is.
   */
  leafTone?: "inherit" | "strong";
  /**
   * The trail's type role. `inherit` (the default) keeps the host's text and
   * each ancestor's control text; `body` sets the whole trail — ancestors,
   * leaf and separators' line — in the body role, for a trail that reads as
   * the page's address rather than as a row of controls.
   */
  text?: "inherit" | "body";
}

const TRAIL_TEXT: Record<NonNullable<BreadcrumbProps["text"]>, string> = {
  inherit: "",
  body: "text-body",
};

const LEAF_WEIGHT: Record<
  NonNullable<BreadcrumbProps["leafWeight"]>,
  string
> = {
  medium: "font-medium",
  semibold: "font-semibold",
  normal: "font-normal",
};

const LEAF_TONE: Record<NonNullable<BreadcrumbProps["leafTone"]>, string> = {
  inherit: "",
  strong: "text-strong-foreground",
};

/**
 * One ancestor: quiet at rest, a soft filled box under the pointer.
 *
 * Muted and normal-weight so the trail reads as one background line and the
 * page's own name is the only thing with weight. The hover mark is a fill
 * rather than an underline — at the size chrome text runs at, an underline on a
 * muted label reads as a defect rather than as a link.
 *
 * A crumb with no `activation` is a path, not a link, so it renders plain
 * text: a button that goes nowhere is worse than no button.
 */
function Crumb({
  label,
  activation,
  textClass,
}: {
  label: ReactNode;
  activation?: Activation;
  textClass: string;
}) {
  if (!activation) {
    return <span className="font-normal text-muted-foreground">{label}</span>;
  }
  return (
    <Button
      variant="ghost"
      aspect="inline"
      {...activationProps(activation)}
      className={cn(
        "px-2xs font-normal text-muted-foreground hover:text-strong-foreground",
        textClass,
      )}
    >
      {label}
    </Button>
  );
}

/**
 * The ancestors, folded: one overflow crumb that gives them all back as a menu.
 *
 * Folding is what a breadcrumb does INSTEAD of taking letters off the page's
 * name — the ancestors are one click from being read in full, the name is not.
 */
function FoldedCrumbs({ segments }: { segments: BreadcrumbSegment[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            aspect="inline"
            aria-label={`Show the ${segments.length} levels above this one`}
            className="px-2xs text-muted-foreground hover:text-strong-foreground"
          >
            <Icon icon={moreHorizIcon} />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        {segments.map((seg) => (
          <DropdownMenuItem
            key={seg.key}
            disabled={seg.activation === undefined}
            {...activationProps(seg.activation)}
          >
            {seg.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The trail: where you are, said quietly, with the page you are on as the one
 * thing that reads first.
 *
 * Three decisions make it that, and they hold together:
 *
 * - **The ancestors are secondary and look it** — muted, normal weight, each
 *   its own hover target; the leaf carries the weight (or, with `leafWeight`
 *   `normal` and `leafTone` `strong`, only the brighter colour).
 * - **The separator has air on both sides** and comes from the theme
 *   (`BreadcrumbSlots.Separator`: chevron or slash), so it is a mark between
 *   crumbs rather than punctuation glued to the words.
 * - **The leaf never pays for the row.** The ancestor run is rigid and folds
 *   whole into an overflow crumb when the room runs out (see
 *   `useAncestorCollapse`), so the page's own name loses letters only once
 *   there is nothing left to fold.
 *
 * The trail takes the row's slack (`fillClasses`) because it has to know how
 * much room it has to answer that last question at all — a box that shrink-wraps
 * its own content cannot see the space around it. Its content stays left-packed,
 * so the slack lands after the trailing actions and nothing moves.
 */
export function Breadcrumb({
  segments,
  actions,
  leafWeight = "medium",
  leafTone = "inherit",
  text = "inherit",
}: BreadcrumbProps) {
  const textClass = TRAIL_TEXT[text];
  const rootRef = useRef<HTMLDivElement>(null);
  const prefixRef = useRef<HTMLDivElement>(null);
  const leafRef = useRef<HTMLSpanElement>(null);

  const lastIndex = segments.length - 1;
  const prefix = segments.slice(0, Math.max(lastIndex, 0));
  const active = segments[lastIndex];

  const folded = useAncestorCollapse({
    rootRef,
    prefixRef,
    leafRef,
    trailKey: segments.map((seg) => seg.key).join(" "),
    foldable: prefix.length > 0,
  });

  if (active === undefined) return null;

  return (
    <Stack
      as={Line}
      ref={rootRef}
      direction="row"
      align="center"
      gap="2xs"
      className={cn(
        fillClasses("x"),
        "[&_svg:not([class*='size-'])]:icon-auto",
        textClass,
      )}
    >
      {prefix.length > 0 && (
        // ONE box for the ancestors in both states, so what folds and what the
        // fit measures are the same element. Rigid: it never gives room back by
        // shrinking — it either stands whole or folds — which is what makes the
        // leaf's own truncation a reliable report that the row is over-full.
        <Stack
          ref={prefixRef}
          direction="row"
          align="center"
          gap="2xs"
          className={rigidClass()}
        >
          {folded ? (
            <>
              <FoldedCrumbs segments={prefix} />
              <TrailSeparator />
            </>
          ) : (
            prefix.map((seg) => (
              <Fragment key={seg.key}>
                <Crumb
                  label={seg.label}
                  activation={seg.activation}
                  textClass={textClass}
                />
                <TrailSeparator />
              </Fragment>
            ))
          )}
        </Stack>
      )}
      <span
        ref={leafRef}
        data-breadcrumb-leaf
        className={cn("truncate", LEAF_WEIGHT[leafWeight], LEAF_TONE[leafTone])}
      >
        {active.label}
      </span>
      {actions && (
        // A trailing action cluster on a row-shaped strip is the `row-actions`
        // primitive, never raw JSX — one implementation owns the sizing, the
        // click/pointerdown guards and the popup-hold. `pin={null}` + always
        // visible is what a breadcrumb's trailing slot is: it sits in flow right
        // after the active segment, and it is never hover-revealed because the
        // trail is chrome, not a row in a list. Rigid keeps it out of the
        // truncation the leaf absorbs.
        <RowActions pin={null} alwaysVisible className={rigidClass()}>
          {actions}
        </RowActions>
      )}
    </Stack>
  );
}
