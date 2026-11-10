import { useEffect, useState, useSyncExternalStore } from "react";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";

/**
 * Which mounted `HintHost` runs the engine. The engine is page-global — ONE
 * tip at a time over the whole page, one stage, one tour — while its host is
 * a root host of every scope (`scope: "each"`): a page that holds the hints
 * plugin only for a `<PluginScope>` (the standalone website's demo) mounts it
 * nowhere but inside that scope. So every mounted host registers, and exactly
 * one runs: the page's when the page holds the plugin (main: the same host as
 * before), else the first scope's. A tip request carries its scope
 * (`TipRequest.scope`), and its seen state and anchors are keyed by it, so
 * whichever host runs serves every scope's tips alike.
 */
const hosts: { id: symbol; page: boolean }[] = [];
const listeners = new Set<() => void>();

function elected(): symbol | null {
  return (hosts.find((h) => h.page) ?? hosts[0])?.id ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const l of listeners) l();
}

/** Registers this host while mounted; true while it is the one that runs. */
export function useElectedHintHost(): boolean {
  const page = usePluginScopeId() === null;
  const [id] = useState(() => Symbol("hint-host"));
  useEffect(() => {
    hosts.push({ id, page });
    emit();
    return () => {
      const at = hosts.findIndex((h) => h.id === id);
      if (at >= 0) hosts.splice(at, 1);
      emit();
    };
  }, [id, page]);
  return useSyncExternalStore(subscribe, () => elected() === id);
}
