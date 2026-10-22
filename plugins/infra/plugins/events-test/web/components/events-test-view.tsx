import {
  Button,
  cn,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCallback, useEffect, useState } from "react";
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
  getEventsTestLog,
  resetEventsTest,
  deleteEventsTestTrigger,
  deleteEventsTestTargeting,
  listEventsTestTriggers,
} from "../../shared/endpoints";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const boltIcon = symbol("bolt");
const deleteIcon = symbol("delete");
const refreshIcon = symbol("refresh");
const sendIcon = symbol("send");

interface TriggerRow {
  id: string;
  jobName: string;
  jobWith: Record<string, unknown>;
  enabled: boolean;
  oneShot: boolean;
  createdAt: string;
  userId: string | null;
}

interface LogEntry {
  label: string;
  userId: string;
  message: string;
  jobId: string;
  firedAt: string;
}

function toastErr(toast: Toast, e: unknown, prefix: string) {
  const msg = e instanceof Error ? e.message : String(e);
  toast({ type: "debug", title: prefix, description: msg, variant: "error" });
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

  // Lists
  const [triggers, setTriggers] = useState<TriggerRow[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [flashedIds, setFlashedIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [t, l] = await Promise.all([
        fetchEndpoint(listEventsTestTriggers, {}),
        fetchEndpoint(getEventsTestLog, {}),
      ]);
      setTriggers(t.rows as unknown as TriggerRow[]);
      setLog(l.entries);
    } catch (e) {
      toastErr(toast, e, "refresh failed");
    }
  }, [fetchEndpoint, toast]);

  // Initial load + light poll so oneShot deletions and new log entries show.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional 1s poll for debug test panel: refresh() writes triggers/log state from two endpoint reads; there is no live-state resource for the events-test endpoints to subscribe to, so a deriving-in-render path does not exist
    void refresh();
    const iv = setInterval(() => {
      void refresh();
    }, 1000);
    return () => clearInterval(iv);
  }, [refresh]);

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
        title: "Subscribed",
        description: `${subUserId.trim() || "match-any"}, ${subOneShot ? "one-shot" : "recurring"}`,
        variant: "success",
      });
      await refresh();
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
        title: "Event emitted",
        description: `pinged(userId="${emitUserId.trim()}")`,
        variant: "info",
      });
      await refresh();
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
        title: "Trigger deleted",
        description: `Trigger ${id}`,
        variant: "success",
      });
      await refresh();
    } catch (e) {
      toastErr(toast, e, "delete failed");
    }
  };

  const onDeleteTargeting = async () => {
    if (!dtLabel.trim()) {
      toast({
        type: "debug",
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
        title: "Triggers swept",
        description: `label="${dtLabel.trim()}"`,
        variant: "success",
      });
      setDtLabel("");
      await refresh();
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
        title: "Job enqueued",
        description: `Job ${jobId}`,
        variant: "success",
      });
      await refresh();
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
        title: "Log cleared",
        description: "Events test log reset",
      });
      await refresh();
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
          <Button variant="ghost" onClick={refresh}>
            <Icon icon={refreshIcon} className="size-4" />
            Refresh
          </Button>
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
        <Section
          title={`Active triggers (${triggers.length})`}
          action={
            <Text as="span" variant="caption" tone="muted">
              polls every 1s — one-shot rows disappear after fire
            </Text>
          }
        >
          {triggers.length === 0 ? (
            <Empty>No triggers subscribed yet.</Empty>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {triggers.map((t) => (
                <Stack
                  key={t.id}
                  direction="row"
                  gap="md"
                  align="center"
                  className={cn(
                    "px-md py-sm text-body transition-colors",
                    flashedIds.has(t.id) && "bg-success/10",
                  )}
                >
                  <Fill>
                    <Stack gap="2xs">
                      <Stack direction="row" gap="sm" align="center">
                        <Badge variant="muted" className="font-mono">
                          {t.userId ?? "(any)"}
                        </Badge>
                        <span className="text-muted-foreground">→</span>
                        <Text as="span" variant="caption" className="font-mono">
                          {t.jobName}
                        </Text>
                        <Text
                          as="span"
                          variant="caption"
                          tone="muted"
                          className="truncate"
                        >
                          {JSON.stringify(t.jobWith)}
                        </Text>
                      </Stack>
                      <Stack direction="row" gap="sm" align="center">
                        <Text as="span" variant="caption" tone="muted">
                          {t.oneShot ? "one-shot" : "recurring"}
                        </Text>
                        <Text as="span" variant="caption" tone="muted">
                          ·
                        </Text>
                        <Text
                          as="span"
                          variant="caption"
                          tone="muted"
                          className="truncate font-mono"
                        >
                          {t.id}
                        </Text>
                      </Stack>
                    </Stack>
                  </Fill>
                  <IconButton
                    icon={deleteIcon}
                    label="Delete trigger"
                    onClick={() => onDeleteTrigger(t.id)}
                  />
                </Stack>
              ))}
            </div>
          )}
        </Section>

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
        <Section
          title={`Job log (${log.length})`}
          action={
            <Button variant="ghost" onClick={onResetLog}>
              <Icon icon={deleteIcon} className="size-4" />
              Clear
            </Button>
          }
        >
          {log.length === 0 ? (
            <Empty>No jobs fired yet. Emit a payload above.</Empty>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {log.map((e, i) => (
                <Stack
                  gap="2xs"
                  key={`${e.jobId}-${e.firedAt}-${i}`}
                  className="px-md py-sm"
                >
                  <Stack direction="row" gap="sm" align="center">
                    <Badge
                      colorClass="bg-info/10 text-info-foreground"
                      className="font-mono"
                    >
                      {e.label}
                    </Badge>
                    <span className="text-muted-foreground">fired for</span>
                    <Text as="span" variant="caption" className="font-mono">
                      userId={e.userId}
                    </Text>
                    <Text
                      as="span"
                      variant="caption"
                      tone="muted"
                      className="truncate"
                    >
                      msg={JSON.stringify(e.message)}
                    </Text>
                  </Stack>
                  <Text
                    as="div"
                    variant="caption"
                    tone="muted"
                    className="truncate"
                  >
                    {new Date(e.firedAt).toLocaleTimeString()} ·{" "}
                    <span className="font-mono">job {e.jobId}</span>
                  </Text>
                </Stack>
              ))}
            </div>
          )}
        </Section>
      </Stack>
    </Scroll>
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
