import type { ComponentProps, ReactNode } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  useActionForm,
  type ShrinkLadder,
} from "@plugins/primitives/plugins/action-presentation/web";
import "./website-nav.css";

/**
 * Everything in the header a reader navigates BY — the pages, the Learn menu,
 * the download, the source and community links, the demo — leaves the row together (one cohort): on a
 * phone the header is the wordmark, Wish and the ☰, and the ☰ holds the whole
 * site. A menu with half the pages, beside a row holding the other half, reads
 * as two broken navigations. Wish is not in it: it is the one thing the site
 * asks a reader to do, so it stays in the row.
 *
 * In the ☰ each of them is a row (`"row"`), never the inline control relocated
 * as itself: a ghost link or a pill floating in a panel is a header out of
 * place, not a menu.
 */
export const WEBSITE_NAV_LADDER: ShrinkLadder = {
  shrinksTo: ["row"],
  yields: "early",
  cohort: "website-nav",
};

type ButtonProps = Omit<
  ComponentProps<typeof Button>,
  "variant" | "shape" | "children"
>;

interface NavLinkProps extends ButtonProps {
  label: string;
  /** A leading glyph, sized by the button (an `<Icon>` element). */
  icon?: ReactNode;
}

/**
 * Standard-look nav link for the shared site header. Page plugins wrap it in
 * their `WebsiteHeader` contributions so every nav entry matches.
 *
 * Two emphases, and the split is about role rather than importance: `quiet`
 * (the default) is a place on this site, and there are several of them, so they
 * must not compete with each other — they sit in the secondary grey and come up
 * to full foreground under the pointer, with no hover box: the colour change is
 * the whole affordance, as in running text. `strong` is the header's one call to
 * action — the thing the site asks a reader to DO rather than somewhere it offers
 * to take them — and there is exactly one of it, which is what earns it a filled
 * pill.
 *
 * The filled pill is the site's INVERTED fill (the foreground colour, with dark
 * type), which the site's palette carries as `secondary`; the brand accent
 * (`primary`) is reserved for identity and hover. The one exception is the pill
 * while a popup it opened is showing (`aria-expanded`, which the popover trigger
 * sets): it takes the accent fill, so the button and the panel hanging off it
 * read as one open thing.
 *
 * A third, `outline`, is an action that is not the call to action — the demo:
 * the call to action's shape (the same pill, the same height) with a hairline
 * instead of the fill, so the two read as one pair of things to do, with Wish
 * the stronger.
 *
 * Each emphasis is its own component, because they leave the row differently:
 * a `quiet` link and an `outline` pill are in the header's navigation cohort
 * ({@link WEBSITE_NAV_LADDER}) and become a row of the ☰ menu (the outline's a
 * quieter one); the `strong` call to action declares nothing here — its item
 * (the Wish popover) says it never leaves, and a second declaration from the
 * button inside would replace that.
 */
export function WebsiteNavLink({
  emphasis = "quiet",
  ...props
}: NavLinkProps & {
  /**
   * `quiet` = a page of this site. `strong` = the header's one call to action.
   * `outline` = an action beside it, in its shape.
   */
  emphasis?: "quiet" | "strong" | "outline";
}) {
  if (emphasis === "strong") return <StrongNavLink {...props} />;
  if (emphasis === "outline") return <OutlineNavLink {...props} />;
  return <QuietNavLink {...props} />;
}

function QuietNavLink({ label, icon, ...rest }: NavLinkProps) {
  const form = useActionForm(WEBSITE_NAV_LADDER);
  if (form === "row") return <WebsiteMenuRow label={label} {...rest} />;
  return (
    <Button
      variant="ghost"
      className="text-muted-foreground hover:text-foreground hover:bg-transparent"
      {...rest}
    >
      {icon}
      {label}
    </Button>
  );
}

function StrongNavLink({ label, icon, ...rest }: NavLinkProps) {
  return (
    <Button
      variant="secondary"
      shape="pill"
      className="font-semibold aria-expanded:bg-primary aria-expanded:text-primary-foreground"
      {...rest}
    >
      {icon}
      {label}
    </Button>
  );
}

function OutlineNavLink({ label, icon, ...rest }: NavLinkProps) {
  const form = useActionForm(WEBSITE_NAV_LADDER);
  if (form === "row")
    return <WebsiteMenuRow label={label} tone="muted" {...rest} />;
  return (
    // Boxed, at the trailing end beside the call to action: spaced as the
    // lead is (the menu row above keeps the menu's own inset).
    <WebsiteNavLead>
      {/* The hairline is a step brighter than the page's rules: it outlines a
          control, not a section. */}
      <Button
        variant="frame"
        shape="pill"
        className="text-foreground border-foreground/22 font-semibold"
        {...rest}
      >
        {icon}
        {label}
      </Button>
    </WebsiteNavLead>
  );
}

/**
 * A pill at the header's trailing end (the demo, then the call to action): the
 * space a word's padding gives it, on its leading side only — the call to
 * action's trailing edge is the header's, and the demo's is the gap to it.
 */
export function WebsiteNavLead({ children }: { children: ReactNode }) {
  return <div className="website-nav-lead">{children}</div>;
}

/**
 * One row of the header's ☰ menu: the destination's name, left-aligned across
 * the panel. `muted` for what comes after the pages (the demo, the download,
 * the source).
 */
export function WebsiteMenuRow({
  label,
  tone = "default",
  ...rest
}: {
  label: string;
  tone?: "default" | "muted";
} & Omit<ComponentProps<typeof Row>, "children" | "icon">) {
  return (
    <Row
      {...rest}
      className={
        tone === "muted"
          ? "website-menu-row website-menu-row-muted"
          : "website-menu-row"
      }
    >
      <Text>{label}</Text>
    </Row>
  );
}
