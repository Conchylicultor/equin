import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Runs, investigateRuns } from "@plugins/runs/web";
import { BACKUP_CATEGORY_ID } from "@plugins/backup/core";
import { BackupRunDetail, backupRunPane } from "@plugins/backup/web";
import { backupRunArm } from "../core";
import {
  BackupArchiveSize,
  BackupSourcesSection,
  BackupSourcesSummary,
  BackupTargetsSection,
  BackupTargetsSummary,
} from "./components/backup-run-sections";
import {
  backupArchiveSize,
  backupSources,
  backupTargetResults,
} from "./internal/payload";
import { backupRunPresentation } from "./internal/presentation";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "The backup arm's presence on the merged run surface: the kind's label, its rows' activation into the backup run-detail pane, its four scalar columns (native status, archive size, source and target counts) as real filterable and sortable SQL dimensions, and the three detail sections — the archive's size on one line, the manifest's source reports, and the per-target outcome with its Grant access remediation.",
  contributions: [
    Runs.Kind({
      arm: backupRunArm,
      link: (run, { openPane }) =>
        openPane.to(backupRunPane, { runId: run.id }, { mode: "push" }),
    }),
    // Its fields' cells; the fields — under their "Backup" band — are the
    // arm's (`backupRunArm`, core).
    backupRunPresentation,
    // A failed backup's Investigate action, in every list of runs.
    investigateRuns(backupRunArm, {
      noun: "backup",
      categoryId: BACKUP_CATEGORY_ID,
      whereToDig: (run) => [
        `the ledger row, with its manifest (per-source outcome) and per-target results: \`select * from backup_runs where id = '${run.id}'\` via \`query_db\` on the main database;`,
        "the backup run-detail pane (Backup → this run) renders the same sources and targets, with each target's repair path;",
        "the assembly runs out of process as the supervised `backup.run` job — its own run history is under Debug → Background → backup.run, and its failure report under Debug → Reports.",
      ],
    }),
    // A one-line section: no `component`, so the host paints one static row
    // with no chevron and nothing to expand. How big the archive came out is
    // the first question asked of a finished backup — a nightly archive that
    // halved means a source stopped contributing — so it sits above the two
    // lists that say what went in and where it went.
    BackupRunDetail.Section({
      id: "archive",
      label: "Archive",
      icon: symbol("archive"),
      summary: BackupArchiveSize,
      // A run that failed before producing an archive has no size, and a titled
      // row reading nothing is worse than no row. Same gate the other two take.
      useAvailable: ({ run }) => backupArchiveSize(run) !== null,
    }),
    // Two sections, not two sub-plugins. Both decode two jsonb columns off the
    // SAME row with the SAME decoders, owned by this arm — the modularity a
    // split would buy is already bought by the slot, and the seam is there for
    // when `backup/targets/google-drive` wants a section of its own.
    BackupRunDetail.Section({
      id: "sources",
      label: "Sources",
      icon: symbol("folder"),
      component: BackupSourcesSection,
      // The verdict beside the title, so a failed source shows while the card
      // is shut — the open state is remembered per section, not per run.
      summary: BackupSourcesSummary,
      // Required rather than a `return null`: the host paints the card before
      // the body and cannot see through it, so an empty manifest would leave a
      // titled bar over nothing. A pre-manifest run has no sources yet.
      useAvailable: ({ run }) => backupSources(run).length > 0,
      useDefaultOpen: ({ run }) =>
        backupSources(run).some((s) => s.outcome === "failed"),
    }),
    BackupRunDetail.Section({
      id: "targets",
      label: "Targets",
      icon: symbol("cloud-upload"),
      component: BackupTargetsSection,
      summary: BackupTargetsSummary,
      useAvailable: ({ run }) => backupTargetResults(run).length > 0,
      // The section holding the only repair path opens itself when there is
      // something to repair. Someone whose backup just broke should not have to
      // find the disclosure that hides the button.
      useDefaultOpen: ({ run }) => backupTargetResults(run).some((t) => !t.ok),
    }),
  ],
} satisfies PluginDefinition;
