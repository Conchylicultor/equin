import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { useRailGuard } from "@plugins/primitives/plugins/css/plugins/rail/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Stack,
  selfClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { RunsDataView } from "@plugins/runs/web";
import { BACKUP_RUN_KIND } from "../../core";
import { runBackup } from "../../shared/endpoints";
import { ConfigGearButton } from "@plugins/config_v2/plugins/config-link/web";
import { backupConfig } from "../../shared/config";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const backupIcon = symbol("backup");

export interface BackupPanelProps {
  /**
   * The run whose detail pane is open, so the list highlights its row.
   *
   * A bare id, not the `{ kind, id }` pair `RunsDataView` wants: this panel is
   * pinned to the backups view and its host reads the id off the backup
   * run-detail pane's own route entry, so the kind is already known here and
   * asking the caller for it again would only be a way to get it wrong.
   */
  selectedRunId?: string;
}

export function BackupPanel({ selectedRunId }: BackupPanelProps) {
  const { mutate: triggerBackup, isPending } = useEndpointMutation(runBackup);
  // This box opens a region, so it takes the region owner's dev-only guard:
  // it measures every child's content edge against the rail published below and
  // names anyone who insets on top of it. The reasoning in the comment below is
  // then checked rather than merely asserted.
  const railRef = useRailGuard<HTMLDivElement>("BackupPanel");

  return (
    // The horizontal inset OPENS a rail region (`rail-x-xl`) rather than merely
    // padding, because a `<DataView>` now lives inside. Every one of its bands —
    // toolbar, list body, group headers — is a `rail-follow`, which resolves
    // "what do I still owe?" as owed → rail → chrome pad. Under a plain `p-xl`
    // nothing is published, so each band would fall through and pay a SECOND
    // inset on top of this one, and any row bleeding to the region edge would
    // overhang by the difference. Publishing sets owed to 0 and the bands add
    // nothing. Block padding stays a plain `py-xl` — same split as SectionCard's
    // body (`rail-x-lg pb-lg`). This mattered not at all for the hand-rolled
    // cards that used to be here; it matters the moment a rail follower is.
    //
    // `max-w-5xl`, not the old `max-w-2xl`: 42rem was sized for the hand-rolled
    // cards that used to be here, and what lives here now is a DataView with a
    // table view — a row's own line truncates gracefully at any width, but a
    // table of six columns does not, and 42rem is where its cells stop being
    // readable. The cap is still a cap: this is prose-and-list chrome, so it is
    // held to a reading width rather than stretched across a 27" display.
    <Stack ref={railRef} gap="xl" className="py-xl rail-x-xl max-w-5xl">
      <Stack gap="xs">
        <Stack direction="row" gap="md" align="center" justify="between">
          <Text as="h2" variant="heading">
            Backup
          </Text>
          <Stack
            direction="row"
            gap="md"
            align="center"
            className={rigidClass()}
          >
            <ConfigGearButton
              descriptor={backupConfig}
              label="Backup settings"
            />
          </Stack>
        </Stack>
        <Text as="p" variant="body" className="text-muted-foreground">
          Archives enabled sources and dispatches to all enabled storage
          targets.
        </Text>
      </Stack>

      {/* Held to its own width rather than stretched: a Stack aligns children
          `stretch`, which was invisible at 2xl and would make this a 1000px
          button now that the container is wide. `selfClass` is the child's own
          cross-axis override — a wrapper would become the flex item and take
          the alignment itself, leaving the button stretched inside it. */}
      <Button
        onClick={() => triggerBackup({})}
        loading={isPending}
        className={selfClass("start")}
      >
        <Icon icon={backupIcon} className="size-4" />
        Run Backup Now
      </Button>

      {/* The history is the shared runs surface, PINNED to its `backups` tab.
          Pinned, not defaulted: `defaultView` is only a fallback, so this panel
          would otherwise join the device-local selection the build surfaces
          share and start showing builds the moment someone clicked that tab over
          there. Pinning also drops the switcher, which is right — inside the
          Backup app this is one scoped list, not a tab strip over every ledger.

          The hand-rolled expand/collapse cards that used to live here are gone,
          and so is the disclosure row that replaced them: a run's detail is now
          a pane of its own, which is what lets the row be an ordinary
          field-driven line that obeys the Properties panel. A new backup
          arrives live, through the `runs` union window's backup arm, rather
          than through this panel re-fetching a list of its own. */}
      <RunsDataView
        pinnedView="backups"
        emptyState={<>No backups yet.</>}
        selectedRun={
          selectedRunId === undefined
            ? undefined
            : { kind: BACKUP_RUN_KIND, id: selectedRunId }
        }
      />
    </Stack>
  );
}
