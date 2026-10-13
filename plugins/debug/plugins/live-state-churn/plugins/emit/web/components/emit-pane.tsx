import { useEffect, useMemo, useState } from "react";
import {
  useEndpointMutation,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { resourcesDebug } from "@plugins/debug/plugins/read-set/core";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  DEFAULT_EMIT_DURATION_MS,
  MAX_EMIT_RATE,
  type EmitStatus,
} from "../../core";
import { startEmit, stopEmit } from "../../shared/endpoints";
import { liveStateEmitStatus } from "../../shared/resources";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const boltIcon = symbol("bolt");

export function EmitPane() {
  // The resource registry: a snapshot (debug/read-set's `resources.debug`),
  // measured on mount and on the Refresh button beside the dropdown.
  const resources = useLive(resourcesDebug);
  // The emitter's status, pushed by the emitter on every change (≤ 1/s).
  const status = useLive(liveStateEmitStatus);
  // Controls lock while a session runs, or until the status is known.
  const locked = foldResource(status, {
    loading: () => true,
    error: () => true,
    ready: (s) => s.active,
  });

  const start = useEndpointMutation(startEmit);
  const stop = useEndpointMutation(stopEmit);

  // Only keyed resources with subscribers can produce an OBSERVABLE no-op push —
  // an empty-diff push to nobody is unobservable. Sort by subscriber count desc.
  // The dropdown's own loading / failed states render beside it.
  const resourceList = foldResource(resources, {
    loading: () => null,
    error: () => null,
    ready: (d) => d,
  });
  const candidates = useMemo(() => {
    if (resourceList === null) return [];
    return resourceList.resources
      .filter((r) => r.mode === "keyed" && r.subscribers > 0)
      .sort((a, b) => b.subscribers - a.subscribers);
  }, [resourceList]);

  const [selectedKey, setSelectedKey] = useState<string>("");
  const [manualKey, setManualKey] = useState<string>("");
  const [rate, setRate] = useState<number>(10);
  const [durationMin, setDurationMin] = useState<number>(
    DEFAULT_EMIT_DURATION_MS / 60_000,
  );

  // Ticks ~1/s so StatusView's remaining-time countdown stays live without
  // calling Date.now() inside render (React Compiler purity requirement).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);

  // Manual key wins when typed (free-text fallback for an off-screen resource).
  const effectiveKey = manualKey.trim() || selectedKey;

  const dropdownItems = useMemo(() => {
    const items: Record<string, string> = {};
    for (const r of candidates) items[r.key] = r.key;
    return items;
  }, [candidates]);

  const errorMessage =
    (start.error && getEndpointErrorMessage(start.error)) ||
    (stop.error && getEndpointErrorMessage(stop.error)) ||
    null;

  return (
    <Scroll axis="y" fill>
      <Inset pad="lg">
        <Stack gap="xl">
          <Stack as="section" gap="sm">
            <Stack direction="row" gap="sm" align="center">
              <Icon icon={boltIcon} className="size-4 text-muted-foreground" />
              <SectionLabel>Synthetic no-op push emitter</SectionLabel>
            </Stack>
            <Text variant="caption" tone="muted">
              Drives N no-op live-state pushes/sec for one resource through the
              real change-feed code path, so re-render / DOM-churn bugs
              reproduce deterministically. Auto-stops after the duration below;
              only keyed resources with live subscribers produce an observable
              push.
            </Text>
          </Stack>

          <Stack as="section" gap="sm">
            <Stack direction="row" gap="sm" align="center" justify="between">
              <SectionLabel>Resource</SectionLabel>
              <Button variant="outline" onClick={() => resources.refresh()}>
                Refresh
              </Button>
            </Stack>
            {resources.status === "error" ? (
              <ResourceErrorInline
                variant="inline"
                subject="the resource registry"
                error={resources.error}
                refetch={resources.refetch}
              />
            ) : null}
            <Select
              items={dropdownItems}
              value={selectedKey || null}
              onValueChange={(v: string | null) => {
                setSelectedKey(v ?? "");
                setManualKey("");
              }}
              disabled={locked || candidates.length === 0}
            >
              <SelectTrigger aria-label="Resource key" className="w-full">
                <SelectValue>
                  {(v: string | null) =>
                    v ?? "Pick a subscribed keyed resource…"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {candidates.map((r) => (
                  <SelectItem key={r.key} value={r.key}>
                    {`${r.key} · ${r.subscribers} sub${r.subscribers === 1 ? "" : "s"}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={manualKey}
              onChange={(e) => setManualKey(e.target.value)}
              placeholder="…or type any resource key (off-screen / no subscribers)"
              disabled={locked}
              aria-label="Manual resource key"
            />
            {resources.status === "loading" ? (
              <Text variant="caption" tone="muted">
                Reading the resource registry…
              </Text>
            ) : resources.status === "ready" && candidates.length === 0 ? (
              <Text variant="caption" tone="muted">
                No keyed resources with live subscribers right now — open a view
                that renders one, or type a key above.
              </Text>
            ) : null}
          </Stack>

          <Stack as="section" gap="sm">
            <SectionLabel>Rate &amp; duration</SectionLabel>
            <Stack direction="row" gap="md" align="end" wrap>
              <Stack gap="2xs">
                <Text variant="caption" tone="muted">
                  Pushes / sec (max {MAX_EMIT_RATE})
                </Text>
                <Input
                  type="number"
                  min={0.1}
                  max={MAX_EMIT_RATE}
                  step={0.1}
                  value={rate}
                  onChange={(e) => setRate(Number(e.target.value))}
                  disabled={locked}
                  aria-label="Pushes per second"
                  className="w-32"
                />
              </Stack>
              <Stack gap="2xs">
                <Text variant="caption" tone="muted">
                  Auto-stop after (minutes)
                </Text>
                <Input
                  type="number"
                  min={0.1}
                  step={0.5}
                  value={durationMin}
                  onChange={(e) => setDurationMin(Number(e.target.value))}
                  disabled={locked}
                  aria-label="Auto-stop minutes"
                  className="w-32"
                />
              </Stack>
            </Stack>
          </Stack>

          <Stack as="section" gap="sm">
            <Stack direction="row" gap="sm" align="center">
              {status.status === "ready" && status.data.active ? (
                <Button
                  variant="destructive"
                  onClick={() => void stop.mutateAsync({})}
                  disabled={stop.isPending}
                >
                  {stop.isPending ? "Stopping…" : "Stop"}
                </Button>
              ) : (
                <Button
                  variant="default"
                  onClick={() =>
                    void start.mutateAsync({
                      body: {
                        key: effectiveKey,
                        rate,
                        durationMs: Math.round(durationMin * 60_000),
                      },
                    })
                  }
                  disabled={start.isPending || !effectiveKey || locked}
                >
                  {start.isPending ? "Starting…" : "Start"}
                </Button>
              )}
            </Stack>
            {errorMessage ? (
              <Placeholder tone="error">{errorMessage}</Placeholder>
            ) : null}
          </Stack>

          <Stack as="section" gap="sm">
            <SectionLabel>Status</SectionLabel>
            <StatusView status={status} nowMs={nowMs} />
          </Stack>
        </Stack>
      </Inset>
    </Scroll>
  );
}

function StatusView({
  status: result,
  nowMs,
}: {
  status: ResourceResult<EmitStatus>;
  nowMs: number;
}) {
  if (result.status === "loading") return <Placeholder>Loading…</Placeholder>;
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the emitter status"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  const status = result.data;
  if (!status.active) {
    return (
      <Text variant="caption" tone="muted">
        Idle.{" "}
        {status.ticks > 0 ? `Last session fired ${status.ticks} ticks.` : ""}
      </Text>
    );
  }

  const remainingMs = status.endsAtMs ? status.endsAtMs - nowMs : 0;
  const remainingS = Math.max(0, Math.round(remainingMs / 1000));
  const noSubscribers = status.lastSubscriberCount === 0;

  return (
    <Stack gap="sm">
      <Stack direction="row" gap="sm" align="center" wrap>
        <Badge variant="success">Emitting</Badge>
        <Badge variant="muted" mono>
          {status.key ?? "—"}
        </Badge>
        <Badge variant="muted">{status.rate}/s</Badge>
        <Badge variant={noSubscribers ? "warning" : "info"}>
          {`${status.lastSubscriberCount} subscriber${status.lastSubscriberCount === 1 ? "" : "s"}`}
        </Badge>
      </Stack>
      <Text variant="caption" tone="muted">
        {`${status.ticks} ticks scheduled · auto-stops in ${remainingS}s`}
      </Text>
      {noSubscribers ? (
        <Placeholder tone="error">
          Nobody subscribed to this key — no churn is observable. Open a view
          that renders this resource, or pick one with live subscribers.
        </Placeholder>
      ) : null}
    </Stack>
  );
}
