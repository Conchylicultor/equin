import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Button,
  ButtonGroup,
  Separator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  ActionFormShield,
  useActionForm,
  type ActionForm,
  type ShrinkLadder,
} from "@plugins/primitives/plugins/action-presentation/web";
import "./website-nav.css";

/**
 * Everything in the header a reader navigates BY — the pages, the demo and
 * download pill, the source link — leaves the row together (one cohort): on a
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
 * A third, `segment`, is one door of a {@link WebsiteNavPill}: two ways to the
 * same thing (try equin here, install it) drawn as one outlined capsule, so
 * they read as one choice rather than as two more pages. Full foreground, since
 * the capsule's hairline already sets them apart from the quiet page links.
 *
 * Each emphasis is its own component, because only one of them declares how it
 * leaves the row: a `quiet` link is in the header's navigation cohort
 * ({@link WEBSITE_NAV_LADDER}) and becomes a row of the ☰ menu; a `segment`
 * takes the form its pill was given; the `strong` call to action declares
 * nothing here — its item (the Wish popover) says it never leaves, and a second
 * declaration from the button inside would replace that.
 */
export function WebsiteNavLink({
  emphasis = "quiet",
  ...props
}: NavLinkProps & {
  /**
   * `quiet` = a page of this site. `strong` = the header's one call to action.
   * `segment` = one door of a {@link WebsiteNavPill}.
   */
  emphasis?: "quiet" | "strong" | "segment";
}) {
  if (emphasis === "strong") return <StrongNavLink {...props} />;
  if (emphasis === "segment") return <SegmentNavLink {...props} />;
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

function SegmentNavLink({ label, icon, ...rest }: NavLinkProps) {
  const form = useContext(PillFormContext);
  if (form === "row")
    return <WebsiteMenuRow label={label} tone="muted" {...rest} />;
  return (
    // The capsule's hairline is a step brighter than the page's rules: it
    // outlines a control, not a section.
    <Button
      variant="frame"
      className="text-foreground border-foreground/16"
      {...rest}
    >
      {icon}
      {label}
    </Button>
  );
}

/** The form a pill's segments render in — the pill's, not their own. */
const PillFormContext = createContext<ActionForm>("full");

/**
 * The header's split pill: its `segment` links joined into one outlined
 * capsule (a pill `ButtonGroup`, whose seams are the segments' shared
 * hairline). For destinations that are one choice made two ways — the demo in
 * the browser, the download for the Mac.
 *
 * In the ☰ menu the capsule comes apart: a rule, then one quieter row per
 * segment, after the pages — what a reader on a phone wants last, since both
 * are for a computer.
 */
export function WebsiteNavPill({
  label,
  children,
}: {
  /** What the pill offers, for assistive tech (`aria-label` of its group). */
  label: string;
  /** `WebsiteNavLink emphasis="segment"` elements. */
  children: ReactNode;
}) {
  const form = useActionForm(WEBSITE_NAV_LADDER);
  // The segments are the pill's to present: shielded, they declare nothing
  // into the pill's item (which would replace its ladder), and read its form.
  const segments = (
    <PillFormContext.Provider value={form}>
      <ActionFormShield>{children}</ActionFormShield>
    </PillFormContext.Provider>
  );
  return form === "row" ? (
    <Stack gap="xs" role="group" aria-label={label}>
      <Separator />
      <Stack gap="none">{segments}</Stack>
    </Stack>
  ) : (
    <div className="website-nav-boxed">
      <ButtonGroup shape="pill" role="group" aria-label={label}>
        {segments}
      </ButtonGroup>
    </div>
  );
}

/**
 * The header's last item, the call to action: the space a word's padding
 * gives it, on its leading side only — its trailing edge is the header's.
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
