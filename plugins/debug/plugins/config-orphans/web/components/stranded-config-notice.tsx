import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { appLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { configOrphansReport } from "../../shared/report";
import { configOrphansRoute } from "../panes";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const warningIcon = symbol("warning");

/**
 * Pinned above Settings → Config when some of the user's own saved settings no
 * longer apply to any config (the audit's `stranded-data` entries). Leftover
 * generated snapshots hold no user data and are not counted.
 *
 * Renders nothing until the audit answers, and nothing when it finds none: a
 * warning that is not known yet has nothing to claim, and an absent warning is
 * what "no problem" looks like. A failed audit is not "no problem" either: it
 * says so inline.
 */
export function StrandedConfigNotice() {
  const audit = useLive(configOrphansReport);
  if (audit.status === "loading") return null;
  if (audit.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the stranded-settings audit"
        error={audit.error}
        refetch={audit.refetch}
      />
    );
  }
  const count = audit.data.orphans.filter(
    (o) => o.riskClass === "stranded-data",
  ).length;
  if (count === 0) return null;

  return (
    <Text
      as="div"
      variant="body"
      className="border-b border-warning/30 bg-warning/10 px-md py-sm text-warning"
    >
      <Stack direction="row" gap="sm" align="center" wrap>
        <Icon icon={warningIcon} className={cn("size-4", rigidClass())} />
        <Fill as="span">
          {count === 1
            ? "1 saved setting no longer applies"
            : `${count} saved settings no longer apply`}
        </Fill>
        <Button
          variant="ghost"
          className="bg-warning/20 hover:bg-warning/30"
          {...appLinkProps(configOrphansRoute.link(debugApp, {}))}
        >
          Review
        </Button>
      </Stack>
    </Text>
  );
}
