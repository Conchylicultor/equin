import { useState, type FormEvent } from "react";
import {
  useOpenPane,
  type PaneObject,
} from "@plugins/primitives/plugins/pane/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  Button,
  ControlSizeProvider,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { subThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { downloadPane } from "@plugins/apps/plugins/website/plugins/pages/plugins/download/web";
import { visionPane } from "@plugins/apps/plugins/website/plugins/pages/plugins/vision/web";
import { foundationsPane } from "@plugins/apps/plugins/website/plugins/pages/plugins/foundations/web";
import { equinClosingTheme } from "../internal/theme";

/**
 * The page's end, in its own sizes (`equinClosingTheme`): "Missing an app?",
 * then the two pages to read next. Its distances from the gallery above and
 * between its two parts are the gallery's score, in `apps-gallery.css`.
 */
export function AppsClosing() {
  return (
    <Theme name={subThemeScope(equinClosingTheme)} surface="none">
      <AppsCompose />
      <AppsReadNext />
    </Theme>
  );
}

/**
 * "Missing an app?" — the gallery's answer to an app it does not have: install
 * equin, then describe it, and an agent composes it. The field is there so the
 * reader can start describing; Build it goes to the download page, because the
 * building happens in equin, not on the site.
 */
function AppsCompose() {
  const openPane = useOpenPane();
  const [idea, setIdea] = useState("");
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    openPane(downloadPane, {}, { mode: "root" });
  };
  return (
    <Card className="website-apps-compose border-foreground/20 rounded-3xl border-dashed bg-transparent shadow-none">
      <Stack direction="row" gap="xl" align="center" wrap>
        <Fill>
          <Stack gap="2xs">
            <Text
              as="h3"
              variant="heading"
              className="font-semibold tracking-[-0.02em]"
            >
              Missing an app?
            </Text>
            <Text as="p" variant="body" tone="muted">
              Install equin, then describe it: an agent composes it from
              existing plugins and builds what is missing.
            </Text>
          </Stack>
        </Fill>
        <Stack
          as="form"
          direction="row"
          gap="xs"
          className="website-apps-compose-ask"
          onSubmit={onSubmit}
        >
          <Fill>
            {/* The field is the small control (42px, 14px text), Build it the
                regular one beside it. */}
            <ControlSizeProvider size="sm">
              <Input
                className="website-apps-compose-field"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="A habit tracker that reads my calendar…"
                aria-label="Describe the app"
              />
            </ControlSizeProvider>
          </Fill>
          <Button type="submit" variant="secondary" className="font-semibold">
            Build it
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}

interface NextPage {
  /** The reader's own question. */
  question: string;
  /** The page that answers it, named on the card's link line. */
  answer: string;
  pane: PaneObject;
}

const NEXT: NextPage[] = [
  { question: "Where is this going?", answer: "The vision", pane: visionPane },
  {
    question: "How is this different from other agentic builders?",
    answer: "The foundations",
    pane: foundationsPane,
  },
];

/**
 * The page's end: the two questions a reader who got through the gallery is
 * likely to have — where the apps are going, and what sets them apart — each
 * as a card that opens the page answering it.
 */
function AppsReadNext() {
  const openPane = useOpenPane();
  return (
    <Grid
      as="nav"
      aria-label="Read next"
      minCellWidth="18rem"
      mode="fit"
      gap="lg"
      className="website-apps-next"
    >
      {NEXT.map((next) => (
        <Card
          key={next.answer}
          as="button"
          interactive
          className="website-app-next hover:bg-card text-left shadow-none"
          {...openPane.link(next.pane, {}, { mode: "root" })}
        >
          <Stack gap="sm" align="start">
            <Text
              as="span"
              variant="subheading"
              className="font-semibold tracking-[-0.02em]"
            >
              {next.question}
            </Text>
            <Text
              as="span"
              variant="body"
              className="website-app-next-go font-semibold"
            >
              {next.answer} →
            </Text>
          </Stack>
        </Card>
      ))}
    </Grid>
  );
}
