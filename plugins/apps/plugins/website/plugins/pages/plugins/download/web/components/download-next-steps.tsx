import type { ReactNode } from "react";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import {
  Stack,
  selfClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  LOCAL_APP_HOST,
  LOCAL_APP_URL,
} from "@plugins/apps/plugins/website/plugins/shell/core";
import { WebsiteArrow } from "@plugins/apps/plugins/website/plugins/shell/web";
import { guidePane } from "@plugins/apps/plugins/website/plugins/pages/plugins/guide/web";
import { DownloadLink } from "./download-link";

/**
 * "Once it is running": the three things to do after the install, as one
 * numbered sequence — open it, learn the basics, make it yours. No boxes: a
 * number, a title and a line each, so the three read as steps rather than as
 * three more cards.
 */
export function DownloadNextSteps() {
  const openPane = useOpenPane();
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
          equin lives at{" "}
          <DownloadLink href={LOCAL_APP_URL}>{LOCAL_APP_HOST}</DownloadLink>,
          and comes back on its own after a restart.
        </Step>
        <Step
          n={2}
          title="Learn the basics"
          action={
            <Text variant="label">
              <DownloadLink {...openPane.link(guidePane, {}, { mode: "root" })}>
                Read the guide
                <WebsiteArrow />
              </DownloadLink>
            </Text>
          }
        >
          Tasks, agents and apps, in ten minutes.
        </Step>
        <Step n={3} title="Make it yours">
          Press Improve in any app and describe the change you want. An agent
          builds it.
        </Step>
      </Grid>
    </Stack>
  );
}

function Step({
  n,
  title,
  action,
  children,
}: {
  n: number;
  title: string;
  action?: ReactNode;
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
        {action}
      </Stack>
    </Stack>
  );
}
