import type { ReactNode } from "react";
import { defineDataView } from "@plugins/primitives/plugins/data-view/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { RunsDataView } from "@plugins/runs/web";

/**
 * The Activity page's own view-instance space over the merged runs surface:
 * its pills (Recent / Running / Needs approval / Failed, each scoped to
 * `kind is deploy`) are authored in this id's view config
 * (`config/apps/deploy/deploy-history/deploy.activity.jsonc`), apart from the
 * build popover's shared `runs` instances.
 */
const ACTIVITY_VIEW = defineDataView("deploy.activity");

/**
 * Activity: every deploy run across every site, newest first — the build
 * popover's runs surface (`RunsDataView`, view pills along the top) with the
 * Deploy app's own instances. A row opens its site's Deployments tab (the
 * deploy arm's `runLinks`).
 */
export function ActivityPage(): ReactNode {
  return (
    // The page column the site page reads at: centred, at most 1180px.
    <Stack gap="none" className="mx-auto w-full max-w-[1180px] px-xl pb-2xl">
      <Inset y="lg">
        <Text as="h1" variant="title">
          Activity
        </Text>
        <Text as="p" variant="caption" tone="muted">
          Deploys and approvals across every site
        </Text>
      </Inset>
      <RunsDataView
        storageKey={ACTIVITY_VIEW}
        emptyState="No deploy runs in this view."
      />
    </Stack>
  );
}
