import type { ReactNode } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import {
  Stack,
  selfClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { LocalAppLink } from "./download-link";

/**
 * "Once it is running": the things to do after the install, as one numbered
 * sequence — open it, make it yours. No boxes: a number, a title and a line
 * each, so they read as steps rather than as more cards.
 *
 * "Learn the basics" (a step linking the guide) comes back once the guide page
 * has something in it; while it is a placeholder the site links it nowhere.
 */
export function DownloadNextSteps() {
  return (
    <Stack gap="xl" className="website-download-next">
      <Text
        variant="eyebrow"
        tone="faint"
        className={cn(selfClass("center"), "font-semibold tracking-[0.12em]")}
      >
        Once it is running
      </Text>
      <Grid as="ol" minCellWidth="14rem" mode="fit" gap="2xl" align="start">
        <Step n={1} title="Open it">
          equin lives at <LocalAppLink />, and comes back on its own after a
          restart.
        </Step>
        <Step n={2} title="Make it yours">
          Press Wish in any app and describe the change you want. An agent
          builds it.
        </Step>
      </Grid>
    </Stack>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <Stack as="li" gap="md" align="start" className="download-step">
      <Center
        aria-hidden
        className="border-border bg-muted size-6 rounded-full border"
      >
        <Text variant="caption" className="font-semibold">
          {n}
        </Text>
      </Center>
      <Stack gap="xsm" align="start">
        <Stack gap="2xs" align="start">
          <Text as="h3" variant="subheading">
            {title}
          </Text>
          <Text as="p" variant="body" tone="muted">
            {children}
          </Text>
        </Stack>
      </Stack>
    </Stack>
  );
}
