import {
  Button,
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, useCallback, useMemo } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { OP_KIND_IDS, type OpKind } from "@plugins/infra/plugins/worktree/core";
import { writeBroadcasts, type BroadcastEntry } from "../../shared/endpoints";
import { broadcastEntries } from "../../shared/resources";
import {
  BroadcastItemActions,
  DeleteBroadcastContext,
  type BroadcastRow,
} from "./broadcast-item-actions";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const BROADCASTS_VIEW = defineDataView("debug.broadcasts");

type BroadcastSeverity = BroadcastEntry["severity"];
type BroadcastCommand = OpKind;

const SEVERITY_STYLES: Record<BroadcastSeverity, string> = {
  error: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning",
  info: "bg-info/10 text-info",
};

const ALL_COMMANDS: readonly BroadcastCommand[] = OP_KIND_IDS;

const NO_ENTRIES: BroadcastEntry[] = [];

// The file's order is the order the CLI prints them in, so the view keeps it
// (no sort in its config). `index` is the entry's position in the file — the
// row key, and what Delete removes.
const fields: FieldDef<BroadcastRow>[] = [
  {
    id: "message",
    label: "Message",
    type: "text",
    primary: true,
    value: (r) => r.entry.message,
    sortable: false,
    filterable: false,
  },
  {
    id: "since",
    label: "Since",
    type: "text",
    value: (r) => (r.entry.since ? `since: ${r.entry.since.slice(0, 8)}` : ""),
    cell: (r) =>
      r.entry.since ? (
        <span className="font-mono">since: {r.entry.since.slice(0, 8)}</span>
      ) : null,
    sortable: false,
    filterable: false,
  },
  {
    id: "until",
    label: "Until",
    type: "text",
    value: (r) => (r.entry.until ? `until: ${r.entry.until.slice(0, 8)}` : ""),
    cell: (r) =>
      r.entry.until ? (
        <span className="font-mono">until: {r.entry.until.slice(0, 8)}</span>
      ) : null,
    sortable: false,
    filterable: false,
  },
  {
    id: "commands",
    label: "Commands",
    type: "text",
    value: (r) => (r.entry.commands ? `[${r.entry.commands.join(", ")}]` : ""),
    sortable: false,
    filterable: false,
  },
  {
    id: "severity",
    label: "Severity",
    type: "enum",
    options: [
      { value: "error", label: "error" },
      { value: "warning", label: "warning" },
      { value: "info", label: "info" },
    ],
    value: (r) => r.entry.severity,
    cell: (r) => (
      <Badge
        colorClass={SEVERITY_STYLES[r.entry.severity]}
        className={rigidClass()}
      >
        {r.entry.severity}
      </Badge>
    ),
    align: "end",
    sortable: false,
    filterable: true,
  },
];

function defaultForm() {
  return {
    severity: "warning" as BroadcastSeverity,
    message: "",
    since: "",
    until: "",
    commands: [] as BroadcastCommand[],
  };
}

export function BroadcastsPanel() {
  const fetchEndpoint = useFetchEndpoint();
  // Live: the file's own watch pushes every change, the pane's saves included.
  const result = useLive(broadcastEntries);
  // The loaded file, for the edits: each rewrites it whole, so neither a
  // pending nor a failed read can be edited (null).
  const ready = foldResource(result, {
    loading: () => null,
    error: () => null,
    ready: (d) => d,
  });
  // The DataView renders the loading and failed states (`readiness`); only a
  // ready read's rows reach the view.
  const entries = foldResource(result, {
    loading: () => NO_ENTRIES,
    error: () => NO_ENTRIES,
    ready: (d) => d.entries,
  });
  const rows = useMemo<BroadcastRow[]>(
    () => entries.map((entry, index) => ({ index, entry })),
    [entries],
  );

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(defaultForm);

  const save = useCallback(
    async (updated: BroadcastEntry[]): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetchEndpoint(
          writeBroadcasts,
          {},
          { body: { entries: updated } },
        );
        if (!res.ok) {
          setError("error" in res ? res.error : "Save failed");
          return false;
        }
        return true;
        // eslint-disable-next-line promise-safety/no-absorbed-failure -- the error IS surfaced to the user via setError(String(e)); false is the save-handler's failure status the caller branches on, not a swallowed error
      } catch (e) {
        setError(String(e));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [fetchEndpoint],
  );

  // Every edit rewrites the file from the entries on screen, so it waits for
  // them: an edit made before the read lands would drop the file's entries.
  const deleteRow = useMemo(
    () =>
      ready === null
        ? null
        : {
            saving,
            remove: async (index: number) => {
              await save(ready.entries.filter((_, i) => i !== index));
            },
          },
    [ready, saving, save],
  );

  const handleAdd = useCallback(async () => {
    if (ready === null || !form.message.trim()) return;
    const entry: BroadcastEntry = {
      severity: form.severity,
      message: form.message.trim(),
    };
    if (form.since.trim()) entry.since = form.since.trim();
    if (form.until.trim()) entry.until = form.until.trim();
    if (form.commands.length > 0) entry.commands = [...form.commands];
    const ok = await save([...ready.entries, entry]);
    if (ok) {
      setForm(defaultForm);
      setShowForm(false);
    }
  }, [form, ready, save]);

  const toggleCommand = (cmd: BroadcastCommand) => {
    setForm((f) => ({
      ...f,
      commands: f.commands.includes(cmd)
        ? f.commands.filter((c) => c !== cmd)
        : [...f.commands, cmd],
    }));
  };

  return (
    <Stack gap="none" className="h-full">
      {/* Header */}
      <Line className="border-b px-lg py-md">
        <Fill>
          <Text as="span" variant="label">
            Broadcast Messages
          </Text>
          {ready && (
            <p
              // eslint-disable-next-line spacing/no-adhoc-spacing -- tiny one-off offset below label, no parent gap to own it
              className="mt-0.5 truncate font-mono text-3xs text-muted-foreground/50"
              title={ready.path}
            >
              {ready.path}
            </p>
          )}
        </Fill>
        <Stack direction="row" gap="xs" align="center" className={rigidClass()}>
          <ControlSizeProvider size="sm">
            <Button
              className="gap-xs"
              disabled={ready === null}
              onClick={() => setShowForm((v) => !v)}
            >
              <Icon icon={addIcon} className="size-4" />
              Add
            </Button>
          </ControlSizeProvider>
        </Stack>
      </Line>

      {/* Error banner */}
      {error && (
        <Text
          as="div"
          variant="caption"
          className="border-b bg-destructive/10 px-lg py-sm text-destructive"
        >
          {error}
        </Text>
      )}

      {/* Add form */}
      {showForm && (
        <Stack gap="sm" className="border-b bg-muted/30 px-lg py-md">
          {/* Severity */}
          <Stack direction="row" gap="sm" align="center">
            <Text
              as="span"
              variant="caption"
              className={cn("w-16 text-muted-foreground", rigidClass())}
            >
              Severity
            </Text>
            <Stack direction="row" gap="xs">
              {(["error", "warning", "info"] as BroadcastSeverity[]).map(
                (s) => (
                  <ToggleChip
                    key={s}
                    variant="ghost"
                    active={form.severity === s}
                    onClick={() => setForm((f) => ({ ...f, severity: s }))}
                    className={
                      form.severity === s ? SEVERITY_STYLES[s] : undefined
                    }
                  >
                    {s}
                  </ToggleChip>
                ),
              )}
            </Stack>
          </Stack>

          {/* Message */}
          <Stack direction="row" gap="sm">
            <Text
              as="span"
              variant="caption"
              // eslint-disable-next-line spacing/no-adhoc-spacing -- one-off top offset to baseline-align label with textarea
              className={cn("mt-1.5 w-16 text-muted-foreground", rigidClass())}
            >
              Message
            </Text>
            <textarea
              className="w-full resize-none rounded-md border bg-background px-sm py-xs text-caption focus:outline-none focus:ring-1 focus:ring-ring"
              rows={2}
              placeholder="Rebase required: breaking DB changes landed in abc1234"
              value={form.message}
              onChange={(e) =>
                setForm((f) => ({ ...f, message: e.target.value }))
              }
            />
          </Stack>

          {/* Since / Until */}
          <Stack direction="row" gap="sm" align="center">
            <Text
              as="span"
              variant="caption"
              className={cn("w-16 text-muted-foreground", rigidClass())}
            >
              Since
            </Text>
            <input
              className="w-28 rounded-md border bg-background px-sm py-xs font-mono text-caption focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="abc1234"
              value={form.since}
              onChange={(e) =>
                setForm((f) => ({ ...f, since: e.target.value }))
              }
            />
            <Text as="span" variant="caption" className="text-muted-foreground">
              Until
            </Text>
            <input
              className="w-28 rounded-md border bg-background px-sm py-xs font-mono text-caption focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="def5678"
              value={form.until}
              onChange={(e) =>
                setForm((f) => ({ ...f, until: e.target.value }))
              }
            />
          </Stack>

          {/* Commands filter */}
          <Stack direction="row" gap="sm" align="center">
            <Text
              as="span"
              variant="caption"
              className={cn("w-16 text-muted-foreground", rigidClass())}
            >
              Commands
            </Text>
            <Stack direction="row" gap="sm" align="center">
              {ALL_COMMANDS.map((cmd) => (
                <Stack
                  as="label"
                  key={cmd}
                  direction="row"
                  gap="xs"
                  align="center"
                >
                  <input
                    type="checkbox"
                    className="size-3"
                    checked={form.commands.includes(cmd)}
                    onChange={() => toggleCommand(cmd)}
                  />
                  <Text as="span" variant="caption">
                    {cmd}
                  </Text>
                </Stack>
              ))}
              {form.commands.length === 0 && (
                <Text
                  as="span"
                  variant="caption"
                  // eslint-disable-next-line spacing/no-adhoc-spacing -- one-off inline gap after checkboxes
                  className="ml-1 italic text-muted-foreground"
                >
                  (all)
                </Text>
              )}
            </Stack>
          </Stack>

          {/* Form actions */}
          <ControlSizeProvider size="sm">
            <Stack direction="row" gap="sm" justify="end">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowForm(false);
                  setForm(defaultForm);
                }}
              >
                Cancel
              </Button>
              <Button
                loading={saving}
                disabled={ready === null || !form.message.trim()}
                onClick={() => handleAdd()}
              >
                Add
              </Button>
            </Stack>
          </ControlSizeProvider>
        </Stack>
      )}

      {/* Entry list */}
      <Scroll fill>
        <DeleteBroadcastContext.Provider value={deleteRow}>
          <DataView<BroadcastRow>
            storageKey={BROADCASTS_VIEW}
            rows={rows}
            readiness={result}
            rowKey={(r) => String(r.index)}
            searchAccessor={(r) => r.entry.message}
            fields={fields}
            views={["list"]}
            itemActions={BroadcastItemActions}
            emptyState="No active broadcasts"
          />
        </DeleteBroadcastContext.Provider>
      </Scroll>
    </Stack>
  );
}
