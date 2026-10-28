import {
  Button,
  cn,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useMemo, useState } from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Stack,
  selfClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { useToast, type Toast } from "@plugins/shell/plugins/notifications/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  subscribeEventsTest,
  emitEventsTest,
  directEnqueueEventsTest,
  resetEventsTest,
  deleteEventsTestTrigger,
  deleteEventsTestTargeting,
} from "../../shared/endpoints";
import { eventsTestLog, type LogEntry } from "../../shared/log";
import { PINGED_EVENT_NAME } from "../../shared/pinged";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  mapResource,
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  eventTriggers,
  type TriggerRow,
} from "@plugins/infra/plugins/events/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const boltIcon = symbol("bolt");
const deleteIcon = symbol("delete");
const sendIcon = symbol("send");

/**
 * This event's bindings, oldest first: events' `event-triggers` value lists
 * every event's, newest first.
 */
function pingedTriggers(rows: readonly TriggerRow[]): TriggerRow[] {
  return rows.filter((t) => t.eventName === PINGED_EVENT_NAME).reverse();
}

/** The binding's `userId` filter, or null for a match-any binding. */
function userIdFilter(t: TriggerRow): string | null {
  const v = t.filters.userId;
  return typeof v === "string" ? v : null;
}

function toastErr(toast: Toast, e: unknown, prefix: string) {
  const msg = e instanceof Error ? e.message : String(e);
  toast({
    type: "debug",
    category: "other",
    title: prefix,
    description: msg,
    variant: "error",
  });
}

export function EventsTestView() {
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();

  // Subscribe form
  const [subUserId, setSubUserId] = useState("");
  const [subLabel, setSubLabel] = useState("");
  const [subOneShot, setSubOneShot] = useState(true);
  const [subBusy, setSubBusy] = useState(false);

  // Emit form
  const [emitUserId, setEmitUserId] = useState("");
  const [emitMessage, setEmitMessage] = useState("");
  const [emitBusy, setEmitBusy] = useState(false);

  // Delete targeting form
  const [dtLabel, setDtLabel] = useState("");
  const [dtBusy, setDtBusy] = useState(false);

  // Direct enqueue form (Layer-1 test — bypasses events entirely)
  const [deLabel, setDeLabel] = useState("");
  const [deUserId, setDeUserId] = useState("");
  const [deMessage, setDeMessage] = useState("");
  const [deBusy, setDeBusy] = useState(false);

  // Live reads: a write below (subscribe, delete, sweep) moves the trigger
  // table, which events' `event-triggers` value is pushed on; a job run or a
  // reset notifies the log. No action re-reads by hand.
  const triggers = useLive(eventTriggers);
  const log = useLive(eventsTestLog);
  const [flashedIds, setFlashedIds] = useState<Set<string>>(new Set());

  // Briefly highlight a trigger id after it's inserted.
  const flashTrigger = (id: string) => {
    setFlashedIds((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setFlashedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 1200);
  };

  // ── Actions ─────────────────────────────────────────────────────────────

  const onSubscribe = async () => {
    if (!subLabel.trim()) {
      toast({
        type: "debug",
        category: "other",
        title: "Missing field",
        description: "label is required",
        variant: "warning",
      });
      return;
    }
    setSubBusy(true);
    try {
      const { id } = await fetchEndpoint(
        subscribeEventsTest,
        {},
        {
          body: {
            userId: subUserId.trim() || undefined,
            label: subLabel.trim(),
            oneShot: subOneShot,
          },
        },
      );
      flashTrigger(id);
      toast({
        type: "debug",
        category: "other",
        title: "Subscribed",
        description: `${subUserId.trim() || "match-any"}, ${subOneShot ? "one-shot" : "recurring"}`,
        variant: "success",
      });
    } catch (e) {
      toastErr(toast, e, "subscribe failed");
    } finally {
      setSubBusy(false);
    }
  };

  const onEmit = async () => {
    if (!emitUserId.trim()) {
      toast({
        type: "debug",
        category: "other",
        title: "Missing field",
        description: "userId is required",
        variant: "warning",
      });
      return;
    }
    setEmitBusy(true);
    try {
      await fetchEndpoint(
        emitEventsTest,
        {},
        {
          body: {
            userId: emitUserId.trim(),
            message: emitMessage.trim() || undefined,
          },
        },
      );
      toast({
        type: "debug",
        category: "other",
        title: "Event emitted",
        description: `pinged(userId="${emitUserId.trim()}")`,
        variant: "info",
      });
    } catch (e) {
      toastErr(toast, e, "emit failed");
    } finally {
      setEmitBusy(false);
    }
  };

  const onDeleteTrigger = async (id: string) => {
    try {
      await fetchEndpoint(deleteEventsTestTrigger, { id });
      toast({
        type: "debug",
        category: "other",
        title: "Trigger deleted",
        description: `Trigger ${id}`,
        variant: "success",
      });
    } catch (e) {
      toastErr(toast, e, "delete failed");
    }
  };

  const onDeleteTargeting = async () => {
    if (!dtLabel.trim()) {
      toast({
        type: "debug",
        category: "other",
        title: "Missing field",
        description: "label is required",
        variant: "warning",
      });
      return;
    }
    setDtBusy(true);
    try {
      await fetchEndpoint(
        deleteEventsTestTargeting,
        {},
        {
          body: { label: dtLabel.trim() },
        },
      );
      toast({
        type: "debug",
        category: "other",
        title: "Triggers swept",
        description: `label="${dtLabel.trim()}"`,
        variant: "success",
      });
      setDtLabel("");
    } catch (e) {
      toastErr(toast, e, "delete-targeting failed");
    } finally {
      setDtBusy(false);
    }
  };

  const onDirectEnqueue = async () => {
    if (!deLabel.trim()) {
      toast({
        type: "debug",
        category: "other",
        title: "Missing field",
        description: "label is required",
        variant: "warning",
      });
      return;
    }
    setDeBusy(true);
    try {
      const { jobId } = await fetchEndpoint(
        directEnqueueEventsTest,
        {},
        {
          body: {
            label: deLabel.trim(),
          },
        },
      );
      toast({
        type: "debug",
        category: "other",
        title: "Job enqueued",
        description: `Job ${jobId}`,
        variant: "success",
      });
    } catch (e) {
      toastErr(toast, e, "direct-enqueue failed");
    } finally {
      setDeBusy(false);
    }
  };

  const onResetLog = async () => {
    try {
      await fetchEndpoint(resetEventsTest, {});
      toast({
        type: "debug",
        category: "other",
        title: "Log cleared",
        description: "Events test log reset",
      });
    } catch (e) {
      toastErr(toast, e, "reset failed");
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <Scroll axis="both" className="h-full p-xl">
      <Stack gap="xl" className="mx-auto w-full max-w-3xl">
        <Stack
          as="header"
          direction="row"
          gap="lg"
          align="start"
          justify="between"
        >
          <div>
            <Text as="h1" variant="title" className="tracking-tight">
              Events Test
            </Text>
            <Text as="p" variant="body" tone="muted">
              Exercises the{" "}
              <code className="rounded-md bg-muted px-xs">events</code> and{" "}
              <code className="rounded-md bg-muted px-xs">jobs</code> plugins:
              subscribe a trigger, emit a payload, watch the job fire. Backed by{" "}
              <code className="rounded-md bg-muted px-xs">
                events_test.pinged
              </code>{" "}
              event and{" "}
              <code className="rounded-md bg-muted px-xs">events_test.log</code>{" "}
              job.
            </Text>
          </div>
        </Stack>

        {/* Subscribe + Emit forms */}
        {/* eslint-disable-next-line layout/no-adhoc-layout -- responsive 1→2 column form grid */}
        <div className="grid gap-lg md:grid-cols-2">
          <Section title="Subscribe">
            <FieldRow label="userId (filter)">
              <Input
                placeholder="empty = match any"
                value={subUserId}
                onChange={(e) => setSubUserId(e.target.value)}
              />
            </FieldRow>
            <FieldRow label="label (job config)">
              <Input
                placeholder="required"
                value={subLabel}
                onChange={(e) => setSubLabel(e.target.value)}
              />
            </FieldRow>
            <Stack as="label" direction="row" gap="sm" align="center">
              <input
                type="checkbox"
                checked={subOneShot}
                onChange={(e) => setSubOneShot(e.target.checked)}
                className="size-4 rounded-md border-input"
              />
              <Text as="span" variant="body" tone="muted">
                oneShot (delete row after fire)
              </Text>
            </Stack>
            <Button onClick={onSubscribe} loading={subBusy}>
              <Icon icon={boltIcon} className="size-4" />
              Subscribe
            </Button>
          </Section>

          <Section title="Emit">
            <FieldRow label="userId (payload)">
              <Input
                placeholder="required"
                value={emitUserId}
                onChange={(e) => setEmitUserId(e.target.value)}
              />
            </FieldRow>
            <FieldRow label="message (payload)">
              <Input
                placeholder="optional; defaults to 'hello'"
                value={emitMessage}
                onChange={(e) => setEmitMessage(e.target.value)}
              />
            </FieldRow>
            <Button
              variant="secondary"
              onClick={onEmit}
              loading={emitBusy}
              className="mt-auto"
            >
              <Icon icon={sendIcon} className="size-4" />
              Emit pinged
            </Button>
          </Section>
        </div>

        {/* Direct enqueue — Layer 1 test (bypasses events) */}
        <Section
          title="Direct enqueue (Layer 1)"
          action={
            <Text as="span" variant="caption" tone="muted">
              calls logPing.enqueue(...) — no trigger row involved
            </Text>
          }
        >
          {/* eslint-disable-next-line layout/no-adhoc-layout -- responsive 1→3 column form grid */}
          <div className="grid gap-md md:grid-cols-3">
            <FieldRow label="label">
              <Input
                placeholder="required"
                value={deLabel}
                onChange={(e) => setDeLabel(e.target.value)}
              />
            </FieldRow>
            <FieldRow label="userId">
              <Input
                placeholder="default 'direct'"
                value={deUserId}
                onChange={(e) => setDeUserId(e.target.value)}
              />
            </FieldRow>
            <FieldRow label="message">
              <Input
                placeholder="default 'direct-enqueued'"
                value={deMessage}
                onChange={(e) => setDeMessage(e.target.value)}
              />
            </FieldRow>
          </div>
          <Button
            variant="secondary"
            onClick={onDirectEnqueue}
            loading={deBusy}
            className={selfClass("start")}
          >
            <Icon icon={sendIcon} className="size-4" />
            Enqueue job
          </Button>
        </Section>

        {/* Active triggers */}
        <TriggersSection
          triggers={triggers}
          flashedIds={flashedIds}
          onDelete={onDeleteTrigger}
        />

        {/* Cleanup by config */}
        <Section title="Delete triggers by job config">
          <Stack direction="row" gap="sm" align="end">
            <Fill>
              <FieldRow label="label match">
                <Input
                  placeholder="exact label to sweep (JSONB @>)"
                  value={dtLabel}
                  onChange={(e) => setDtLabel(e.target.value)}
                />
              </FieldRow>
            </Fill>
            <Button
              variant="outline"
              onClick={onDeleteTargeting}
              loading={dtBusy}
            >
              <Icon icon={deleteIcon} className="size-4" />
              Sweep
            </Button>
          </Stack>
        </Section>

        {/* Job log */}
        <LogSection log={log} onReset={onResetLog} />
      </Stack>
    </Scroll>
  );
}

// ── The two live lists ───────────────────────────────────────────────────

const TRIGGERS_VIEW = defineDataView("events-test.triggers");
const LOG_VIEW = defineDataView("events-test.log");

/** A log entry with the key it is listed by (one job may log twice). */
type LogRow = LogEntry & { key: string };

const LOG_FIELDS: FieldDef<LogRow>[] = [
  {
    id: "label",
    label: "Label",
    type: "text",
    width: "8rem",
    value: (e) => e.label,
    cell: (e) => (
      <Badge colorClass="bg-info/10 text-info-foreground" className="font-mono">
        {e.label}
      </Badge>
    ),
  },
  {
    id: "userId",
    label: "userId",
    type: "text",
    width: "8rem",
    value: (e) => e.userId,
    cell: (e) => (
      <Text as="span" variant="caption" className="font-mono">
        {e.userId}
      </Text>
    ),
  },
  {
    id: "message",
    label: "Message",
    type: "text",
    primary: true,
    width: "minmax(0,1fr)",
    value: (e) => e.message,
    cell: (e) => (
      <Text as="span" variant="caption" tone="muted" className="truncate">
        {JSON.stringify(e.message)}
      </Text>
    ),
  },
  {
    id: "firedAt",
    label: "Fired",
    type: "date",
    width: "6rem",
    value: (e) => new Date(e.firedAt),
    cell: (e) => (
      <Text as="span" variant="caption" tone="muted">
        {new Date(e.firedAt).toLocaleTimeString()}
      </Text>
    ),
  },
  {
    id: "jobId",
    label: "Job",
    type: "text",
    width: "6rem",
    value: (e) => e.jobId,
    cell: (e) => (
      <Text as="span" variant="caption" tone="muted" className="font-mono">
        {e.jobId}
      </Text>
    ),
  },
];

function TriggersSection({
  triggers,
  flashedIds,
  onDelete,
}: {
  triggers: ResourceResult<TriggerRow[]>;
  flashedIds: ReadonlySet<string>;
  onDelete: (id: string) => Promise<void>;
}) {
  const pinged = mapResource(triggers, pingedTriggers);
  const triggerFields = useMemo<FieldDef<TriggerRow>[]>(
    () => [
      {
        id: "userId",
        label: "userId",
        type: "text",
        width: "8rem",
        value: (t) => userIdFilter(t) ?? "(any)",
        cell: (t) => (
          <Badge
            variant="muted"
            className={cn(
              "font-mono transition-colors",
              flashedIds.has(t.id) && "bg-success/10",
            )}
          >
            {userIdFilter(t) ?? "(any)"}
          </Badge>
        ),
      },
      {
        id: "jobName",
        label: "Job",
        type: "text",
        primary: true,
        width: "minmax(0,1fr)",
        value: (t) => t.jobName,
        cell: (t) => (
          <Text as="span" variant="caption" className="truncate font-mono">
            {t.jobName}{" "}
            <Text as="span" variant="caption" tone="muted">
              {JSON.stringify(t.jobWith)}
            </Text>
          </Text>
        ),
      },
      {
        id: "kind",
        label: "Kind",
        type: "enum",
        width: "6rem",
        value: (t) => (t.oneShot ? "one-shot" : "recurring"),
        options: [
          { value: "one-shot", label: "one-shot" },
          { value: "recurring", label: "recurring" },
        ],
      },
      {
        id: "id",
        label: "Id",
        type: "text",
        width: "12rem",
        value: (t) => t.id,
        cell: (t) => (
          <Text
            as="span"
            variant="caption"
            tone="muted"
            className="truncate font-mono"
          >
            {t.id}
          </Text>
        ),
      },
      {
        id: "delete",
        label: "Delete",
        header: false,
        width: "3rem",
        align: "end",
        sortable: false,
        filterable: false,
        cell: (t) => (
          <IconButton
            icon={deleteIcon}
            label="Delete trigger"
            onClick={() => onDelete(t.id)}
          />
        ),
      },
    ],
    [flashedIds, onDelete],
  );
  return (
    <Section
      title={foldResource(pinged, {
        loading: () => "Active triggers",
        error: () => "Active triggers",
        ready: (rows) => `Active triggers (${rows.length})`,
      })}
      action={
        <Text as="span" variant="caption" tone="muted">
          live — one-shot rows disappear after fire
        </Text>
      }
    >
      {foldResource(pinged, {
        loading: () => <Loading />,
        error: (error) => (
          <ResourceErrorInline
            error={error}
            refetch={pinged.refetch}
            variant="block"
            subject="the triggers"
          />
        ),
        ready: (rows) => (
          <DataView<TriggerRow>
            rows={rows}
            fields={triggerFields}
            rowKey={(t) => t.id}
            storageKey={TRIGGERS_VIEW}
            views={["table"]}
            density="compact"
            emptyState={<Empty>No triggers subscribed yet.</Empty>}
          />
        ),
      })}
    </Section>
  );
}

function LogSection({
  log,
  onReset,
}: {
  log: ResourceResult<{ entries: LogEntry[]; total: number }>;
  onReset: () => Promise<void>;
}) {
  return (
    <Section
      title={foldResource(log, {
        loading: () => "Job log",
        error: () => "Job log",
        ready: ({ total }) => `Job log (${total})`,
      })}
      action={
        <Button variant="ghost" onClick={onReset}>
          <Icon icon={deleteIcon} className="size-4" />
          Clear
        </Button>
      }
    >
      {foldResource(log, {
        loading: () => <Loading />,
        error: (error) => (
          <ResourceErrorInline
            error={error}
            refetch={log.refetch}
            variant="block"
            subject="the job log"
          />
        ),
        ready: ({ entries, total }) => (
          <Stack gap="xs">
            {total > entries.length && (
              <Text as="p" variant="caption" tone="muted">
                The latest {entries.length} of {total} entries.
              </Text>
            )}
            <DataView<LogRow>
              rows={entries.map((e, i) => ({
                ...e,
                key: `${e.jobId}-${e.firedAt}-${i}`,
              }))}
              fields={LOG_FIELDS}
              rowKey={(e) => e.key}
              storageKey={LOG_VIEW}
              views={["table"]}
              density="compact"
              emptyState={
                <Empty>No jobs fired yet. Emit a payload above.</Empty>
              }
            />
          </Stack>
        ),
      })}
    </Section>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Surface level="raised" as="section" className="p-lg">
      <Stack gap="md">
        <Stack direction="row" gap="sm" align="center" justify="between">
          <Text as="h2" variant="label">
            {title}
          </Text>
          {action}
        </Stack>
        <Stack gap="md">{children}</Stack>
      </Stack>
    </Surface>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Stack gap="xs">
      <Text as="label" variant="caption" tone="muted">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <Text
      as="div"
      variant="body"
      tone="muted"
      className="rounded-md border border-dashed border-border px-md py-xl text-center"
    >
      {children}
    </Text>
  );
}
