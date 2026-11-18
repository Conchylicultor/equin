import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";

/**
 * Which mounted root host of a page-global service runs. The service's engine
 * is ONE per page (one tip at a time, one music player), while its host is a
 * root host of every scope (`scope: "each"`): a page that holds the plugin
 * only for a `<PluginScope>` (the standalone website's demo) mounts it nowhere
 * but inside that scope. So every mounted host registers under its service,
 * and exactly one runs: the page's when the page holds the plugin (main: the
 * same host as a page-only root would be), else the first scope's.
 */
interface Host {
  readonly id: symbol;
  readonly page: boolean;
}

const hostsByService = new Map<string, Host[]>();
const listeners = new Set<() => void>();

function elected(service: string): symbol | null {
  const hosts = hostsByService.get(service) ?? [];
  return (hosts.find((h) => h.page) ?? hosts[0])?.id ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const l of listeners) l();
}

/**
 * Registers this host of `service` while mounted; true while it is the one
 * that runs. `service` names the engine the hosts share — hosts of different
 * services are elected apart.
 */
export function useElectedHost(service: string): boolean {
  const page = usePluginScopeId() === null;
  const [id] = useState(() => Symbol(service));
  useEffect(() => {
    const hosts = hostsByService.get(service) ?? [];
    hostsByService.set(service, [...hosts, { id, page }]);
    emit();
    return () => {
      const rest = (hostsByService.get(service) ?? []).filter(
        (h) => h.id !== id,
      );
      if (rest.length === 0) hostsByService.delete(service);
      else hostsByService.set(service, rest);
      emit();
    };
  }, [service, id, page]);
  const isElected = useCallback(() => elected(service) === id, [service, id]);
  return useSyncExternalStore(subscribe, isElected, isElected);
}
