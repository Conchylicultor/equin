import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { WebsiteHero } from "@plugins/apps/plugins/website/plugins/shell/web";
import { HeroFilm } from "./hero-film";
import "./hero-section.css";

const HEADLINE_LEAD = "A personal OS that ";
const HEADLINE_ACCENT = "evolves on request";
const LEDE_BRAND = "equin";
const LEDE_TAIL =
  " is an experimental open-source platform to rebuild custom versions of every application, tailored to each user's unique needs. An exploration of the new kind of software that agents unlock.";

/**
 * The three properties the headline's claim rests on. A closed set of three
 * sentences, not a collection — plain data.
 */
const PROPERTIES = [
  {
    name: "Self-evolving",
    body: "The application modifies itself as your needs evolve.",
  },
  {
    name: "Integrated",
    body: "One unified application, rather than many isolated ones.",
  },
  {
    name: "Personal",
    body: "Built for your own use case, not the average one.",
  },
];

/**
 * The homepage's opening: one sentence saying what equin is, the paragraph that
 * says what that means, the showcase film, and the three properties it rests on.
 *
 * The heading, its lede and the glow behind them are the shell's
 * `WebsiteHero` — every page opens the same way. What is the homepage's own is
 * the row of three properties under the lede: small flat tiles, left-aligned
 * inside the centred heading so each reads as a sentence, capped at 860px so
 * the row stays narrower than the reading measure. The film sits between the
 * lede and that row, so it reads as part of the claim — and the row keeps it
 * apart from the live demo below.
 */
export function HeroSection() {
  return (
    <WebsiteHero
      kind="home"
      lead={HEADLINE_LEAD}
      accent={HEADLINE_ACCENT}
      trail="."
      lede={
        <>
          <Text className="text-foreground font-semibold">{LEDE_BRAND}</Text>
          {LEDE_TAIL}
        </>
      }
    >
      <HeroFilm />
      <Grid
        minCellWidth="14rem"
        mode="fit"
        gap="md"
        className="w-full max-w-[53.75rem] text-left"
      >
        {PROPERTIES.map((property) => (
          <Card
            key={property.name}
            className="website-hero-property p-lg rounded-xl shadow-none"
          >
            <Stack gap="2xs">
              <Inline gap="sm">
                <StatusDot
                  colorClass="bg-primary text-primary-text"
                  className="website-hero-property-dot"
                />
                <Text variant="label" className="font-semibold">
                  {property.name}
                </Text>
              </Inline>
              <Text as="p" variant="label" tone="muted" className="font-normal">
                {property.body}
              </Text>
            </Stack>
          </Card>
        ))}
      </Grid>
    </WebsiteHero>
  );
}
