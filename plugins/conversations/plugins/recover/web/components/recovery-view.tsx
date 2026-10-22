import {
  Button,
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { useCallback, useMemo, useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { conversationsGone } from "@plugins/tasks/plugins/tasks-core/core";
import {
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
import type { MachineAvailability } from "@plugins/infra/plugins/endpoints/core";
import { restoreBatch } from "../../shared/endpoints";
import type { Conversation } from "@plugins/tasks/plugins/tasks-core/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const historyIcon = symbol("history");

// The newest ended conversations Recovery lists: a window of the live
// `conversations-gone` collection (its `maxLimit` admits it), so a close
// enters at the top and a restore leaves, pushed — no REST page to re-fetch.
const GONE_PAGE_SIZE = 50;

const CLUSTER_WINDOW_MS = 1000;

function groupByEndedAt(items: Conversation[]): Conversation[][] {
  const groups: Conversation[][] = [];
  for (const item of items) {
    const head = groups[groups.length - 1];
    const prev = head?.[head.length - 1];
    if (
      head &&
      prev?.endedAt &&
      item.endedAt &&
      prev.endedAt.getTime() - item.endedAt.getTime() <= CLUSTER_WINDOW_MS
    ) {
      head.push(item);
    } else {
      groups.push([item]);
    }
  }
  return groups;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function RecoveryView() {
  const gone = useLive(conversationsGone, { limit: GONE_PAGE_SIZE });
  const fetchEndpoint = useFetchEndpoint();
  // Restoring respawns agents, which needs the computer: on a host without it
  // (the demo) every Restore is disabled and says why.
  const availability = useMachineAvailability(restoreBatch);
  // What to list: the window (already newest-first by `endedAt`), or — when a
  // re-read failed — the rows last seen; `undefined` while nothing is known.
  const items = foldResource(gone, {
    loading: () => undefined,
    error: (_error, stale) => stale,
    ready: (rows) => rows,
  });

  const [pending, setPending] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());

  const groups = useMemo(
    () => (items === undefined ? [] : groupByEndedAt(items)),
    [items],
  );

  const setPendingFor = useCallback((ids: string[], value: boolean) => {
    setPending((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (value) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const restore = useCallback(
    async (ids: string[]) => {
      setPendingFor(ids, true);
      setRowErrors((prev) => {
        const next = new Map(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      try {
        const result = await fetchEndpoint(restoreBatch, {}, { body: { ids } });
        if (result.kind === "unavailable") throw new Error(result.message);
        const data = result.value;
        setRowErrors((prev) => {
          const next = new Map(prev);
          for (const r of data.results) {
            if (!r.ok) next.set(r.id, r.error);
          }
          return next;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setRowErrors((prev) => {
          const next = new Map(prev);
          for (const id of ids) next.set(id, msg);
          return next;
        });
      } finally {
        setPendingFor(ids, false);
      }
    },
    [fetchEndpoint, setPendingFor],
  );

  return (
    <Stack gap="none" className="h-full">
      <Stack
        direction="row"
        gap="md"
        align="center"
        justify="between"
        className="px-lg py-md border-b"
      >
        <Stack
          direction="row"
          gap="sm"
          align="center"
          className={fillClasses("x")}
        >
          <Text
            as="h2"
            variant="label"
            className={cn("font-semibold", rigidClass())}
          >
            Recovery
          </Text>
          {items !== undefined && items.length > 0 && (
            <Text as="span" variant="caption" tone="muted" className="truncate">
              {items.length} recently closed
            </Text>
          )}
        </Stack>
      </Stack>

      <Scroll axis="both" fill>
        {gone.status === "loading" ? (
          <Loading />
        ) : gone.status === "error" && items === undefined ? (
          <Stack gap="sm" align="start" className="py-sm">
            <Placeholder tone="error">
              Couldn't load recently closed conversations: {gone.error.message}.
            </Placeholder>
            <div className="px-md">
              <ControlSizeProvider size="sm">
                <Button variant="outline" onClick={() => void gone.refetch()}>
                  Retry
                </Button>
              </ControlSizeProvider>
            </div>
          </Stack>
        ) : items === undefined || items.length === 0 ? (
          <Placeholder>No recently closed conversations.</Placeholder>
        ) : (
          <Stack gap="none">
            {groups.map((group) => {
              const first = group[0];
              if (!first) return null;
              return (
                <ClusterGroup
                  key={first.id}
                  group={group}
                  pending={pending}
                  rowErrors={rowErrors}
                  availability={availability}
                  onRestore={restore}
                />
              );
            })}
          </Stack>
        )}
      </Scroll>
    </Stack>
  );
}

function ClusterGroup({
  group,
  pending,
  rowErrors,
  availability,
  onRestore,
}: {
  group: Conversation[];
  pending: Set<string>;
  rowErrors: Map<string, string>;
  availability: MachineAvailability;
  onRestore: (ids: string[]) => Promise<void>;
}) {
  const first = group[0];
  const isCluster = group.length > 1;
  const endedAt = first?.endedAt ?? null;
  const groupIds = useMemo(() => group.map((c) => c.id), [group]);
  const anyPending = groupIds.some((id) => pending.has(id));
  if (!first) return null;

  return (
    <div className="border-b">
      {isCluster && endedAt && (
        <Stack
          direction="row"
          gap="sm"
          align="center"
          justify="between"
          className="px-lg py-sm bg-muted/30 border-b"
        >
          <Text as="span" variant="caption" className="font-medium">
            {formatTime(endedAt)} — {group.length} conversations closed
          </Text>
          <ControlSizeProvider size="sm">
            <Button
              variant="outline"
              onClick={() => onRestore(groupIds)}
              loading={anyPending}
              disabled={!availability.available}
              tooltip={
                availability.available ? undefined : availability.message
              }
            >
              {/* eslint-disable-next-line spacing/no-adhoc-spacing -- leading-icon offset inside button label */}
              <Icon icon={historyIcon} className="size-3.5 mr-1" />
              Restore all ({group.length})
            </Button>
          </ControlSizeProvider>
        </Stack>
      )}
      {group.map((conversation) => (
        <ConversationRow
          key={conversation.id}
          conversation={conversation}
          pending={pending.has(conversation.id)}
          error={rowErrors.get(conversation.id) ?? null}
          availability={availability}
          onRestore={() => onRestore([conversation.id])}
        />
      ))}
    </div>
  );
}

function ConversationRow({
  conversation,
  pending,
  error,
  availability,
  onRestore,
}: {
  conversation: Conversation;
  pending: boolean;
  error: string | null;
  availability: MachineAvailability;
  onRestore: () => void;
}) {
  return (
    <>
      <Stack
        direction="row"
        gap="md"
        align="center"
        className="px-lg py-sm hover:bg-muted/30"
      >
        <Stack gap="2xs" className={fillClasses("x")}>
          <Text as="span" variant="caption" className="truncate font-medium">
            {conversation.title ?? conversation.id}
          </Text>
          <Stack
            direction="row"
            gap="sm"
            align="center"
            className="text-3xs text-muted-foreground"
          >
            <span>{conversation.model}</span>
            {conversation.endedAt && (
              <span>{formatTime(conversation.endedAt)}</span>
            )}
          </Stack>
        </Stack>
        <ControlSizeProvider size="sm">
          <Button
            variant="outline"
            onClick={onRestore}
            loading={pending}
            disabled={!availability.available}
            tooltip={availability.available ? undefined : availability.message}
          >
            {/* eslint-disable-next-line spacing/no-adhoc-spacing -- leading-icon offset inside button label */}
            <Icon icon={historyIcon} className="size-3.5 mr-1" />
            Restore
          </Button>
        </ControlSizeProvider>
      </Stack>
      {error && (
        <div className="px-lg py-xs bg-muted/10">
          <Text as="span" variant="caption" tone="destructive">
            {error}
          </Text>
        </div>
      )}
    </>
  );
}
