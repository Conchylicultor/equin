import type { ReactNode } from "react";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useWebsiteSectionReach } from "../internal/section-reach";
import "./website-band.css";

/**
 * The site's one reading measure — `--website-measure`, declared in
 * `website-band.css` and read by the header's gutter too. See {@link WebsiteBand}.
 */
const MEASURE = "mx-auto w-full max-w-(--website-measure)";

/**
 * A band's place in the page's vertical score. Each role is a block padding
 * pair declared once in `website-band.css`; see that file for what each
 * measures and why the density ramp is not the source.
 */
export type WebsiteBandRhythm =
  | "hero"
  | "page-hero"
  | "section"
  | "interlude"
  | "closing"
  | "footer"
  | "page"
  | "page-body";

const RHYTHM_CLASS: Record<WebsiteBandRhythm, string> = {
  hero: "website-band-hero",
  "page-hero": "website-band-page-hero",
  section: "website-band-section",
  interlude: "website-band-interlude",
  closing: "website-band-closing",
  footer: "website-band-footer",
  page: "website-band-page",
  "page-body": "website-band-page-body",
};

export interface WebsiteBandProps {
  /**
   * The band's name on its page (`hero`, `layers`, `footer`): how far readers
   * get is measured per band, as `section_reach` `<page>/<section>` — see
   * `useWebsiteSectionReach`. Required, so no band ships unmeasured.
   */
  section: string;
  /** Host element. Defaults to `section` — pass `footer` for the site footer. */
  as?: "section" | "footer" | "header";
  /** Hairline above this band's content, separating it from the one before. */
  divider?: boolean;
  /** The band's role on the page, which fixes its block padding. Defaults to `page`. */
  rhythm?: WebsiteBandRhythm;
  /**
   * Lands on the measure box — for a band that centres its text
   * (`text-center`) or positions a decorative layer (`relative`). Never a width:
   * a band that narrows any other way stops starting on the site's shared left
   * edge (`mx-auto` centres whatever cap you give it), and a heading that no
   * longer lines up with the cards below it reads as a mistake. A narrower
   * paragraph caps ITSELF inside the measure instead (the hero's lede).
   */
  className?: string;
  children: ReactNode;
}

/**
 * One horizontal band of the site.
 *
 * Every website section is a full-width strip whose content sits on ONE shared
 * reading measure, centred in the viewport — so the wordmark, the hero, the two
 * layer cards and the footer all line up on the same left and right edges no
 * matter which plugin drew them. That measure is declared here and nowhere else;
 * a section that sets its own `max-w-*` is a section that will drift.
 *
 * `divider` paints the hairline ABOVE the band. The site separates its bands
 * with a rule rather than with more air, which is what keeps a long page reading
 * as one document rather than a stack of unrelated cards. The rule is as wide
 * as the measure, not the viewport — it belongs to the column of text it
 * divides — which is why it and the rhythm's padding sit on the measure box:
 * the rule above the padding, both inside the gutter.
 *
 * `rhythm` is the band's vertical padding, named by the band's role rather than
 * spelled as a ramp step: the page's rhythm is a designed scale of its own, and
 * it lives in `website-band.css`.
 */
export function WebsiteBand({
  section,
  as: As = "section",
  divider = false,
  rhythm = "page",
  className,
  children,
}: WebsiteBandProps) {
  const reachRef = useWebsiteSectionReach<HTMLElement>(section);
  return (
    <As ref={reachRef}>
      {/* The side gutter only bites once the viewport is narrower than the
          measure plus two gutters; at full width the measure centres itself. */}
      <Inset x="2xl">
        <div
          className={cn(
            MEASURE,
            RHYTHM_CLASS[rhythm],
            divider && "border-border border-t",
            className,
          )}
        >
          {children}
        </div>
      </Inset>
    </As>
  );
}
