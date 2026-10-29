import { useSyncExternalStore } from "react";
import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";

// Whether this tab previews the git defaults: every `useConfig` /
// `useConfigResult` read resolves to the committed layer (`configGitValues`)
// instead of the user's config, and every `useSetConfig` write is refused — the
// app as a brand-new user would see it. Per tab (session storage): it survives
// a reload (a build reloads the page) but never leaks into another tab or a
// later session, where a forgotten preview would read as lost settings.
const previewStore = defineStore({
  owner: "config-v2.git-defaults-preview",
  label: "Git defaults preview",
  area: "session",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.literal(true),
});

function readPreview(): boolean {
  return previewStore.read().kind === "value";
}

function subscribePreview(onChange: () => void): () => void {
  return previewStore.subscribe("", onChange);
}

/** Whether this tab reads the git defaults instead of the user's config. */
export function useConfigPreview(): boolean {
  return useSyncExternalStore(subscribePreview, readPreview);
}

/** Turn this tab's git-defaults preview on or off. */
export function setConfigPreview(on: boolean): void {
  if (!on) {
    previewStore.remove("");
    return;
  }
  const written = previewStore.write("", true);
  // The store has already announced the refusal; the switch must not claim a
  // state it could not record.
  if (!written.ok) {
    throw new Error(
      `[config-v2] could not turn the git-defaults preview on: ${written.reason}`,
    );
  }
}

/** Why a config write was refused before it was sent. */
export type ConfigWriteRefusal =
  // The tab previews the git defaults, which are read-only.
  | { kind: "preview" }
  // The document is in conflict: the app shows the new defaults while the
  // user's own values are parked in the override, so a write computed from
  // what is shown would replace the parked values with the defaults.
  | { kind: "conflict"; storePath: string; scopeId?: string };

type RefusalListener<K extends ConfigWriteRefusal["kind"]> = (
  refusal: Extract<ConfigWriteRefusal, { kind: K }>,
) => void;

const refusalListeners = new Map<
  ConfigWriteRefusal["kind"],
  Set<(refusal: ConfigWriteRefusal) => void>
>();

/**
 * Listen for config writes refused for one reason — the owning UI says so (a
 * toast); config_v2 cannot draw one itself (the toast's chrome reads config).
 */
export function onConfigWriteRefused<K extends ConfigWriteRefusal["kind"]>(
  kind: K,
  listener: RefusalListener<K>,
): () => void {
  const set = refusalListeners.get(kind) ?? new Set();
  refusalListeners.set(kind, set);
  const entry = listener as (refusal: ConfigWriteRefusal) => void;
  set.add(entry);
  return () => {
    set.delete(entry);
  };
}

/** Say a write was refused; throws when nothing can say it. */
export function announceRefusedWrite(refusal: ConfigWriteRefusal): void {
  const set = refusalListeners.get(refusal.kind);
  if (!set || set.size === 0) {
    throw new Error(
      `[config-v2] a config write was refused (${refusal.kind}) and no listener reports it`,
    );
  }
  for (const listener of set) listener(refusal);
}
