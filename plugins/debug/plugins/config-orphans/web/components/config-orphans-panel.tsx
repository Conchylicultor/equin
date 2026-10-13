import { useMemo } from "react";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import type { OrphanEntry } from "@plugins/config_v2/core";
import {
  DataView,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import type { FieldDef } from "@plugins/primitives/plugins/data-view/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { configOrphansReport } from "../../shared/report";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const ORPHANS_VIEW = defineDataView("debug.config-orphans");

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

// Local human-readable byte formatter — mail/attachments' `formatBytes` lives
// behind a plugin-private path, so a small local copy is the boundary-legal
// choice for this one call site.
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    UNITS.length - 1,
  );
  const value = bytes / 1024 ** exp;
  const text = exp === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text.replace(/\.0$/, "")} ${UNITS[exp]}`;
}

const NO_ORPHANS: OrphanEntry[] = [];

export function ConfigOrphansPanel() {
  const audit = useLive(configOrphansReport);
  // The DataView renders the loading and failed states (`readiness`); only a
  // ready audit's rows reach the view.
  const orphans = foldResource(audit, {
    loading: () => NO_ORPHANS,
    error: () => NO_ORPHANS,
    ready: (d) => d.orphans,
  });

  const fields = useMemo<FieldDef<OrphanEntry>[]>(
    () => [
      {
        id: "path",
        label: "Config",
        type: "text",
        primary: true,
        value: (r) => r.storeKey,
        cell: (r) => <span className="font-mono">{r.storeKey}</span>,
        sortable: true,
        width: "minmax(0,2fr)",
      },
      {
        id: "risk",
        label: "Risk",
        type: "enum",
        value: (r) => r.riskClass,
        options: [
          { value: "noise", label: "Noise (no user data)" },
          { value: "stranded-data", label: "Stranded user data" },
        ],
        cell: (r) =>
          r.riskClass === "stranded-data" ? (
            <Badge variant="warning">Stranded user data</Badge>
          ) : (
            <Badge variant="muted">Noise</Badge>
          ),
        sortable: true,
        filterable: true,
        width: "12rem",
      },
      {
        id: "reason",
        label: "Reason",
        type: "enum",
        value: (r) => r.reason,
        options: [
          { value: "relocated", label: "Relocated" },
          { value: "removed", label: "Removed" },
        ],
        cell: (r) =>
          r.reason === "relocated" ? (
            <span className="text-muted-foreground">
              Relocated
              {r.relocatedToHier ? (
                <>
                  {" → "}
                  <span className="font-mono">{r.relocatedToHier}</span>
                </>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">Removed</span>
          ),
        sortable: true,
        filterable: true,
        width: "14rem",
      },
      {
        id: "relocatedTo",
        label: "Now at",
        type: "text",
        // Filter/search dimension: the hierarchy a live descriptor of the same
        // name now lives at (present only for relocated orphans).
        value: (r) => r.relocatedToHier ?? "",
        sortable: true,
        filterable: true,
        width: "auto",
      },
      {
        id: "files",
        label: "Files",
        type: "int",
        value: (r) => r.files.length,
        cell: (r) => (
          <span className="tabular-nums text-muted-foreground">
            {r.files.length}
          </span>
        ),
        sortable: true,
        align: "end",
        width: "5rem",
      },
      {
        id: "size",
        label: "Size",
        type: "int",
        value: (r) => r.totalBytes,
        cell: (r) => (
          <span className="tabular-nums text-muted-foreground">
            {formatBytes(r.totalBytes)}
          </span>
        ),
        sortable: true,
        align: "end",
        width: "6rem",
      },
      {
        id: "modified",
        label: "Modified",
        type: "date",
        value: (r) => new Date(r.newestMtimeMs),
        cell: (r) => (
          <span className="text-muted-foreground">
            <RelativeTime date={new Date(r.newestMtimeMs)} />
          </span>
        ),
        sortable: true,
        width: "7rem",
      },
    ],
    [],
  );

  return (
    <Stack gap="none">
      <Text
        as="div"
        variant="caption"
        className="px-lg py-sm text-muted-foreground border-b"
      >
        On-disk config files in this worktree whose{" "}
        <span className="font-mono">defineConfig</span> descriptor is no longer
        live. <strong>Stranded user data</strong> means a real user
        customization (a base or scoped override) silently stopped applying
        because its descriptor moved or was removed — review it before any
        deletion. Read-only audit; nothing is deleted.
      </Text>
      <DataView<OrphanEntry>
        rows={orphans}
        fields={fields}
        rowKey={(r) => r.storeKey}
        views={["table"]}
        storageKey={ORPHANS_VIEW}
        readiness={audit}
        searchAccessor={(r) => `${r.storeKey} ${r.relocatedToHier ?? ""}`}
        emptyState={<>No orphaned config files — user config dir is clean.</>}
      />
    </Stack>
  );
}
