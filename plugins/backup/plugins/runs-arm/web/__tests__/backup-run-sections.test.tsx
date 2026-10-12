import { afterEach, describe, expect, it, vi } from "vitest";

// Mounting NotificationsProvider otherwise schedules real fetch flushes at
// module eval — the convention the live-state hazard suites established.
vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({
  clientLog: () => {},
}));

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { queryKeyFor } from "@plugins/primitives/plugins/live-state/web";
import { createLiveStateHarness } from "@plugins/primitives/plugins/live-state/web/testing";
import { authState } from "@plugins/auth/core";
import type { RunRow } from "@plugins/runs/core";
import {
  BackupArchiveSize,
  BackupSourcesSection,
  BackupSourcesSummary,
  BackupTargetsSection,
  BackupTargetsSummary,
} from "../components/backup-run-sections";
import { backupArchiveSize } from "../internal/payload";

/**
 * The two sections of the backup run-detail pane. This proves the two things a
 * field-driven row would have dropped silently when the old expand/collapse row
 * was deleted:
 *
 * - the **Grant access** button on a target that failed for want of an OAuth
 *   scope, which is the only in-app repair path for a Drive backup whose token
 *   expired;
 * - the manifest's source reports and their items.
 *
 * There is no disclosure to open any more: the section host owns that, and the
 * bodies are rendered directly. What the row's own tests asserted about the
 * collapsed line (chips, an absolute start time, no fabricated "in progress")
 * is not restated here — those values are ordinary declared fields now, and the
 * list renders them from the schema.
 */

function backupRun(overrides: Record<string, unknown> = {}): RunRow {
  // `backup.<field>` keys are the arm's own columns: they ride `$columns.backup`.
  const flat: Record<string, unknown> = {
    runKey: "backup:run-1",
    kind: "backup",
    id: "run-1",
    label: "Backup · 2 sources",
    outcome: "partial",
    trigger: "manual",
    startedAt: new Date("2026-08-20T09:30:00Z"),
    finishedAt: new Date("2026-08-20T09:31:40Z"),
    duration: 100_000,
    namespace: null,
    message: null,
    "backup.status": "partial",
    "backup.archiveSize": 5 * 1024 * 1024,
    "backup.sourceCount": 2,
    "backup.targetCount": 2,
    "backup.targetResults": [
      { targetId: "local", ok: true, detail: "/backups/2026-08-20" },
      {
        targetId: "google-drive",
        ok: false,
        detail: "insufficient permissions",
        needsConsent: true,
        consent: {
          providerId: "google",
          scopes: ["https://www.googleapis.com/auth/drive.file"],
        },
      },
    ],
    "backup.sources": [
      {
        id: "config",
        name: "Config",
        outcome: "included",
        items: [{ label: "config/", detail: "12 files" }],
        sizeBytes: 2048,
      },
      {
        id: "secrets",
        name: "Secrets",
        outcome: "included",
        items: [{ label: "secrets.json.enc" }],
        sizeBytes: 512,
      },
      // Skipped sources are dropped by the decoder, not by the section — the
      // same reading the `sourceCount` column takes, so the two cannot disagree.
      {
        id: "databases",
        name: "Databases",
        outcome: "skipped",
        items: [],
        sizeBytes: 0,
      },
    ],
    ...overrides,
  };
  const row: Record<string, unknown> = {};
  const slice: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key.startsWith("backup.")) slice[key.slice("backup.".length)] = value;
    else row[key] = value;
  }
  return { ...row, $columns: { backup: slice } } as unknown as RunRow;
}

/**
 * The Grant access button reads the shared auth state through `useResource`, so
 * the section genuinely needs a live-state host. Seeding the query with the
 * resource's own empty value settles it without a server: the button does not
 * depend on the state to render, only to merge already-granted scopes when it is
 * pressed.
 */
function renderSection(node: ReactNode): void {
  const live = createLiveStateHarness();
  live.queryClient.setQueryData(queryKeyFor(authState.key, undefined), {
    providers: {},
  });
  render(<>{node}</>, { wrapper: live.Wrapper });
}

afterEach(cleanup);

describe("backup run detail sections", () => {
  it("offers Grant access on a target that failed for want of a scope", () => {
    renderSection(<BackupTargetsSection run={backupRun()} />);

    const grant = screen.getByRole("button", { name: /grant access/i });
    expect(grant).not.toBeNull();
    // A real, enabled control — not a label styled like one.
    expect(grant.tagName).toBe("BUTTON");
    expect((grant as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers no Grant access when every target succeeded", () => {
    renderSection(
      <BackupTargetsSection
        run={backupRun({
          outcome: "succeeded",
          "backup.status": "ok",
          "backup.targetResults": [{ targetId: "local", ok: true }],
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: /grant access/i })).toBeNull();
    expect(screen.getByText("local")).not.toBeNull();
  });

  it("carries the manifest's non-skipped sources and their items", () => {
    renderSection(<BackupSourcesSection run={backupRun()} />);

    expect(screen.getByText("Config")).not.toBeNull();
    expect(screen.getByText("Secrets")).not.toBeNull();
    expect(screen.queryByText("Databases")).toBeNull();
    expect(screen.getByText(/config\/ — 12 files/)).not.toBeNull();
    expect(screen.getByText("secrets.json.enc")).not.toBeNull();
  });

  it("states how big the archive came out", () => {
    renderSection(<BackupArchiveSize run={backupRun()} />);

    expect(screen.getByText("5.0 MB")).not.toBeNull();
  });

  /**
   * The regression this arm exists for. A source that threw used to have no
   * spelling at all: the only way to report one was to reject, which took the
   * whole archive down, so the manifest never carried one and nothing rendered
   * it. Now it is listed WITH its own words — a failed source did put something
   * in the archive, and this pane is where someone finds out what came up
   * short.
   */
  it("names a failed source and says what stopped it", () => {
    renderSection(
      <BackupSourcesSection
        run={backupRun({
          "backup.sources": [
            {
              id: "config",
              name: "Config",
              outcome: "included",
              items: [{ label: "config/", detail: "12 files" }],
              sizeBytes: 2048,
            },
            {
              id: "databases",
              name: "Databases",
              outcome: "failed",
              error:
                '1 of 7 databases could not be dumped and is NOT in this archive:\n  - sonata: database "sonata": kept table links to a left-out one',
              // Partly assembled: the six that dumped ARE in the archive.
              items: [{ label: "singularity", detail: "136 tables" }],
              sizeBytes: 4096,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Databases")).not.toBeNull();
    expect(
      screen.getByText(/1 of 7 databases could not be dumped/),
    ).not.toBeNull();
    expect(screen.getByText(/sonata/)).not.toBeNull();
    // What it DID get through is still listed beside the failure.
    expect(screen.getByText(/singularity — 136 tables/)).not.toBeNull();
    // And an unaffected source is untouched.
    expect(screen.getByText("Config")).not.toBeNull();
  });

  /**
   * The boundary of the backup, not just its contents: what a source chose not
   * to archive is listed under its own heading, apart from the items — an
   * orphan database by name, so someone can decide to drop it.
   */
  it("lists what a source deliberately left out, apart from its items", () => {
    renderSection(
      <BackupSourcesSection
        run={backupRun({
          "backup.sources": [
            {
              id: "databases",
              name: "Databases",
              outcome: "included",
              items: [
                {
                  label: "sonata",
                  detail:
                    "60 tables / 10 rows (rows of mail_threads kept: mail_drafts still links to it)",
                },
              ],
              leftOut: [
                {
                  label: "212 worktree copies",
                  detail: "disposable, never backed up",
                },
                { label: "website", detail: "no app owns this database" },
              ],
              sizeBytes: 4096,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Not backed up")).not.toBeNull();
    expect(
      screen.getByText("website — no app owns this database"),
    ).not.toBeNull();
    expect(screen.getByText(/212 worktree copies/)).not.toBeNull();
    expect(screen.getByText(/mail_drafts still links to it/)).not.toBeNull();
  });

  /**
   * Every backup manifest written before this change says `skipped: boolean`
   * and has no `outcome` at all. They are months of real history on the runs
   * surface, so the decoder maps the legacy boolean rather than rejecting —
   * `true` is the skipped arm, `false` the included one, which is lossless
   * because v2 could not express a failure.
   */
  it("still reads a v2 manifest, whose sources carry `skipped` and no outcome", () => {
    renderSection(
      <BackupSourcesSection
        run={backupRun({
          "backup.sources": [
            {
              id: "config",
              name: "Config",
              skipped: false,
              items: [{ label: "config/", detail: "12 files" }],
              sizeBytes: 2048,
            },
            {
              id: "databases",
              name: "Databases",
              skipped: true,
              items: [],
              sizeBytes: 0,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Config")).not.toBeNull();
    expect(screen.getByText(/config\/ — 12 files/)).not.toBeNull();
    expect(screen.queryByText("Databases")).toBeNull();
  });

  // The gate the Archive section declares, checked on the value the section
  // itself reads: a run that failed before writing an archive paints no row at
  // all rather than a titled "Archive" over nothing.
  it("has no size to state before an archive exists", () => {
    const run = backupRun({
      outcome: "failed",
      "backup.status": "failed",
      "backup.archiveSize": null,
    });
    expect(backupArchiveSize(run)).toBeNull();

    renderSection(<BackupArchiveSize run={run} />);
    expect(screen.queryByText(/B$|KB|MB|GB/)).toBeNull();
  });

  // The header verdicts sit beside the title, so a failure shows while the
  // card is folded — the open state is remembered per section, not per run.
  it("says in the Targets header how many targets failed", () => {
    renderSection(<BackupTargetsSummary run={backupRun()} />);
    expect(screen.getByText("1 of 2 failed")).not.toBeNull();
  });

  it("says in the Sources header that every source went fine", () => {
    renderSection(<BackupSourcesSummary run={backupRun()} />);
    expect(screen.getByText("2 of 2 ok")).not.toBeNull();
  });
});
