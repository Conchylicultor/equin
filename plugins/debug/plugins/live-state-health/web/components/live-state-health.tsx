import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  useNotificationsClient,
  type ChannelStatuses,
  type DebugSnapshot,
  type DebugSub,
  type TransportInfo,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { WsStatus } from "@plugins/primitives/plugins/networking/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { SingleLineProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { ServerResourcesSection } from "./server-resources-section";

/** Tailwind dot color per socket state — green=healthy, amber=transient, red=dead. */
const SOCKET_DOT: Record<WsStatus, string> = {
  open: "bg-success",
  connecting: "bg-warning",
  reconnecting: "bg-warning",
  closed: "bg-destructive",
};

export function LiveStateHealth(): ReactElement {
  const client = useNotificationsClient();
  // subscribeDebug fires on any sub/version/socket/transport change; bump a counter
  // to re-read the snapshot. RelativeTime self-ticks for age, so no manual timer.
  const [, bump] = useState(0);
  useEffect(() => client.subscribeDebug(() => bump((n) => n + 1)), [client]);

  const snapshot: DebugSnapshot = client.debugSnapshot();

  // Default sort: most-recently-updated first — the freshest activity (and, by
  // contrast, the longest-stale subs at the bottom) is what a wedge hunt cares about.
  const subs = useMemo(
    () => [...snapshot.subs].sort((a, b) => b.lastAppliedAt - a.lastAppliedAt),
    [snapshot.subs],
  );

  return (
    <Stack gap="xl">
        <SocketsSection sockets={snapshot.sockets} />
        <TransportSection transport={snapshot.transport} />
        <ResourcesSection subs={subs} />
        <ServerResourcesSection />
    </Stack>
  );
}

function SocketsSection({
  sockets,
}: {
  sockets: ChannelStatuses;
}): ReactElement {
  return (
    <Stack as="section" gap="sm">
      <SectionLabel>Sockets</SectionLabel>
      <Stack gap="xs">
        <SocketRow label="Worktree" status={sockets.worktree} />
        <SocketRow label="Central" status={sockets.central} />
      </Stack>
    </Stack>
  );
}

function SocketRow({
  label,
  status,
}: {
  label: string;
  status: WsStatus;
}): ReactElement {
  return (
    <Stack direction="row" gap="sm" align="center">
      <StatusDot colorClass={SOCKET_DOT[status]} />
      <Text variant="body" className="w-24">
        {label}
      </Text>
      <Text
        variant="caption"
        tone={status === "open" ? "muted" : "destructive"}
      >
        {status}
      </Text>
    </Stack>
  );
}

function TransportSection({
  transport,
}: {
  transport: { worktree: TransportInfo; central: TransportInfo };
}): ReactElement {
  return (
    <Stack as="section" gap="sm">
      <SectionLabel>Shared transport</SectionLabel>
      <Stack gap="xs">
        <TransportRow label="Worktree" info={transport.worktree} />
        <TransportRow label="Central" info={transport.central} />
      </Stack>
    </Stack>
  );
}

function TransportRow({
  label,
  info,
}: {
  label: string;
  info: TransportInfo;
}): ReactElement {
  // How many tabs share the worker's socket: a count that only grows as tabs
  // close means ports are leaking.
  const tabs =
    info.attachedTabs === null
      ? "not attached"
      : `${info.attachedTabs} ${info.attachedTabs === 1 ? "tab" : "tabs"} attached`;
  const conn =
    info.connection === null
      ? ""
      : ` · connection ${info.connection.slice(0, 8)}`;
  return (
    <Stack direction="row" gap="sm" align="center">
      <Text variant="body" className="w-24">
        {label}
      </Text>
      <Text variant="caption" tone="muted">
        {tabs + conn}
      </Text>
    </Stack>
  );
}

function ResourcesSection({ subs }: { subs: DebugSub[] }): ReactElement {
  return (
    // No `min-h-0`: this section has no internal scroll, so allowing it to shrink
    // below its content height (the flex-item default in the pane's `h-full`
    // column) makes its rows overflow and the sibling section below overlap them.
    // Sized to content, the pane's own `overflow-auto` scrolls instead.
    <Stack as="section" gap="sm">
      <SectionLabel>
        Resources <span className="opacity-60">{subs.length}</span>
      </SectionLabel>
      {subs.length === 0 ? (
        <Text variant="caption" tone="muted">
          No active subscriptions.
        </Text>
      ) : (
        <Stack gap="none">
          {/* eslint-disable layout/no-adhoc-layout -- weighted (flex-[2]) + fixed-width column header row; not a single content/meta Frame */}
          {/* eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794239361-kagy27): a hand-rolled rule strip; move it onto its surface's header/footer or a Band */}
          <div className="flex items-center gap-md border-b py-xs">
            <HeadCell className="flex-[2]">Key</HeadCell>
            <HeadCell className="flex-[2]">Params</HeadCell>
            <HeadCell className="w-16 text-right">Version</HeadCell>
            <HeadCell className="w-24 text-right">Last update</HeadCell>
            <HeadCell className="w-14 text-right">Refs</HeadCell>
            <HeadCell className="w-20">Socket</HeadCell>
          </div>
          {/* eslint-enable layout/no-adhoc-layout */}
          {subs.map((sub) => (
            <ResourceRow
              key={`${sub.socket}:${sub.key}:${sub.paramsKey}`}
              sub={sub}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function HeadCell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): ReactElement {
  return <SectionLabel className={className}>{children}</SectionLabel>;
}

function ResourceRow({ sub }: { sub: DebugSub }): ReactElement {
  /* eslint-disable layout/no-adhoc-layout -- weighted (flex-[2]) + fixed-width column data row mirroring the header; not a single content/meta Frame */
  return (
    // eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794239361-kagy27): a hand-rolled rule strip; move it onto its surface's header/footer or a Band
    <div className="flex items-center gap-md border-b border-border/40 py-xs">
      <SingleLineProvider value={true}>
        <Text className="flex-[2]">
          <Text variant="caption">{sub.key}</Text>
        </Text>
      </SingleLineProvider>
      <SingleLineProvider value={true}>
        <Text className="flex-[2]" title={sub.paramsKey}>
          <Text variant="caption" tone="muted">
            {sub.paramsKey}
          </Text>
        </Text>
      </SingleLineProvider>
      <Text
        variant="caption"
        tone="muted"
        className="w-16 text-right tabular-nums"
      >
        {sub.version}
      </Text>
      <Text
        variant="caption"
        tone="muted"
        className="w-24 text-right tabular-nums"
      >
        {sub.lastAppliedAt > 0 ? (
          <RelativeTime date={new Date(sub.lastAppliedAt)} />
        ) : (
          "never"
        )}
      </Text>
      <Text
        variant="caption"
        tone="muted"
        className="w-14 text-right tabular-nums"
      >
        {sub.refcount}
      </Text>
      <Text variant="caption" tone="muted" className="w-20">
        {sub.socket}
      </Text>
    </div>
  );
  /* eslint-enable layout/no-adhoc-layout */
}
