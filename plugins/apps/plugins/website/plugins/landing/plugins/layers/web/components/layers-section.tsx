import type { ReactNode } from "react";
import {
  useOpenPane,
  type PaneObject,
} from "@plugins/primitives/plugins/pane/web";
import { appsPane } from "@plugins/apps/plugins/website/plugins/pages/plugins/apps/web";
import { visionPane } from "@plugins/apps/plugins/website/plugins/pages/plugins/vision/web";
import { foundationsPane } from "@plugins/apps/plugins/website/plugins/pages/plugins/foundations/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { WebsiteBand } from "@plugins/apps/plugins/website/plugins/shell/web";
import { AppsShelf } from "./apps-shelf";
import "./layers-section.css";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const arrowDownwardIcon = symbol("arrow-downward");
const arrowForwardIcon = symbol("arrow-forward");

const HEADING = "What is equin?";
const SUBHEADING = "Three layers, each built on the one before it.";

/**
 * "What is equin?" — the homepage's map of the project, as three stacked layers
 * joined by arrows: the technical foundations, the applications built on them,
 * and the vision they add up to.
 *
 * Each layer is one click target, opening the page that tells more about it.
 * The three are the same card, so they read as one stack: a flat panel that
 * lifts under the pointer, with a round arrow at the end of its title row that
 * is always visible — so the card says it can be opened before the pointer is
 * anywhere near it, which a hover lift alone cannot (and on a touch screen
 * never does).
 *
 * The stack is capped at 860px inside the reading measure, centred, like the
 * heading above it.
 */
export function LayersSection() {
  return (
    <WebsiteBand section="layers" divider rhythm="section">
      <Stack gap="2xl" className="mx-auto w-full max-w-[53.75rem]">
        <Stack gap="sm" align="center" className="text-center">
          <Text as="h2" variant="title" className="tracking-tight">
            {HEADING}
          </Text>
          <Text as="p" variant="body" tone="muted">
            {SUBHEADING}
          </Text>
        </Stack>
        <Stack gap="none">
          <Layer
            title="The technical foundations"
            body="A platform (framework, harness, plugin system) to build production-grade applications autonomously. 1M+ lines of code without human review."
            pane={foundationsPane}
          />
          <LayerArrow />
          <Layer
            title="Applications, fully customizable"
            body="Every app is a composition of plugins, so it can be reshaped by the person using it."
            pane={appsPane}
          >
            <AppsShelf />
          </Layer>
          <LayerArrow />
          <Layer
            title="The vision: An OS-like surface"
            body="A single app to replace all others, customized for every user."
            pane={visionPane}
          />
        </Stack>
      </Stack>
    </WebsiteBand>
  );
}

function Layer({
  title,
  body,
  pane,
  children,
}: {
  title: string;
  body: string;
  pane: PaneObject;
  children?: ReactNode;
}) {
  const openPane = useOpenPane();
  return (
    // A flat panel at rest; under the pointer it lifts and its border
    // brightens toward the foreground (`website-layer`, see the CSS), in place
    // of the interactive card's accent border and tinted fill.
    <Card className="website-layer hover:border-foreground/22 hover:bg-card rounded-2xl text-left shadow-none">
      {/* The layer's link is a full-bleed button BEHIND its content, so the
          links inside a layer (the applications layer's apps) stay links of
          their own above it, and every other press lands on the layer. */}
      <button
        type="button"
        className="website-layer-hit"
        aria-label={title}
        {...openPane.link(pane, {}, { mode: "root" })}
      />
      <Stack gap="lg" className="website-layer-content">
        {/* The arrow is a real track beside the text, not a corner overlay, so
            a long title wraps before it rather than running under it. */}
        <Stack direction="row" gap="lg" align="start">
          <Fill>
            <Stack gap="2xs">
              <Text as="h3" variant="heading" className="tracking-tight">
                {title}
              </Text>
              <Text as="p" variant="body" tone="muted">
                {body}
              </Text>
            </Stack>
          </Fill>
          <Center
            className={cn(
              rigidClass(),
              "website-layer-open border-border text-muted-foreground size-8.5 rounded-full border",
            )}
          >
            <Icon icon={arrowForwardIcon} aria-hidden />
          </Center>
        </Stack>
        {children}
      </Stack>
    </Card>
  );
}

/** The downward arrow between two layers: the next one is built on this one. */
function LayerArrow() {
  return (
    <Center className="text-muted-foreground/60 h-11">
      <Icon icon={arrowDownwardIcon} aria-hidden />
    </Center>
  );
}
