import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { WebsiteBand } from "@plugins/apps/plugins/website/plugins/shell/web";
import { ISSUES_URL } from "@plugins/apps/plugins/website/plugins/shell/core";
import { brand } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { ContactReach } from "./contact-reach";
import { MailAddress } from "./mail-address";

const githubIcon = brand("github");

const CARD_CLASS = "rounded-2xl shadow-none";

/**
 * The page's closing band: two ways to reach the project, one per reader.
 *
 * Someone who wants to back this writes to us — the address sits in the
 * sentence (with a copy icon on hover), and "Get in touch" grows the card into
 * a message form that the site's own server stores and emails on
 * (`apps/deploy/site-messages/intake`). Someone using equin files their bug,
 * feature request or question on GitHub, where it can be tracked. Two readers,
 * two different destinations.
 *
 * The filled button is the site's INVERTED fill (the foreground colour with dark
 * type — `secondary` in the site's palette), the other an outline; the brand
 * accent stays for identity and hover.
 */
export function ContactSection() {
  return (
    <WebsiteBand divider rhythm="closing">
      {/* `fit` collapses the empty trailing track: at the site's measure a 20rem
          minimum packs three, and two cards in a three-track row read as one
          card missing. The two cards share a row's height, so the GitHub
          card grows with the form beside it. */}
      <Grid minCellWidth="22rem" mode="fit" gap="lg">
        <Card className={CARD_CLASS}>
          <Stack gap="xl" align="start">
            <Stack gap="sm">
              <Text as="h2" variant="heading" className="tracking-tight">
                Interested in supporting this vision?
              </Text>
              <Text as="p" variant="body" tone="muted">
                Investors, collaborators, and anyone who thinks software should
                evolve itself. Write to <MailAddress />
              </Text>
            </Stack>
            <ContactReach />
          </Stack>
        </Card>
        <Card className={CARD_CLASS}>
          <Stack gap="xl" align="start">
            <Stack gap="sm">
              <Text as="h2" variant="heading" className="tracking-tight">
                Have feedback?
              </Text>
              <Text as="p" variant="body" tone="muted">
                Send your bug reports, feature requests and questions on GitHub.
              </Text>
            </Stack>
            <Button
              variant="outline"
              className="font-semibold"
              render={
                <a
                  href={ISSUES_URL}
                  // GitHub opens beside the site.
                  target="_blank"
                  rel="noreferrer noopener"
                />
              }
            >
              <Icon icon={githubIcon} />
              Open an issue
            </Button>
          </Stack>
        </Card>
      </Grid>
    </WebsiteBand>
  );
}
