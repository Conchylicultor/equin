import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { HealthLineView } from "@plugins/shell/plugins/health-report/web";
import type { SiteHealth } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/core";
import { SiteBodyView, SiteGlanceView } from "../../web/components/site-row";
import { siteStatus, siteTitle } from "../../web/internal/status";
import type { SiteExhibitState } from "../../web/slots";
import { SECOND_SITE, siteIn } from "./fixtures";

/** One site's row as the health report draws it, every part on its fixture. */
function SiteLine({
  site,
  state,
  open,
}: {
  site: SiteHealth;
  state: SiteExhibitState;
  open: boolean;
}) {
  return (
    <HealthLineView
      status={siteStatus(site)}
      title={siteTitle(site)}
      actions={<SiteGlanceView site={site} exhibit={state} />}
      detail={() => <SiteBodyView site={site} exhibit={state} />}
      defaultOpen={open}
    />
  );
}

/**
 * The deployed-site row in one state, in a panel like the report's popover:
 * expanded, as the prototype draws it — and with `two`, a second site under
 * it, live and current, collapsed to its one line. Inert: an exhibit never
 * deploys, retries or opens anything.
 */
export function SiteRowExhibit({
  state,
  two = false,
}: {
  state: SiteExhibitState;
  two?: boolean;
}) {
  return (
    <div inert>
      <Surface level="overlay" className="rounded-xl border p-xs">
        <Stack gap="2xs">
          <SiteLine site={siteIn(state)} state={state} open />
          {two ? (
            <SiteLine site={SECOND_SITE} state="live" open={false} />
          ) : null}
        </Stack>
      </Surface>
    </div>
  );
}
