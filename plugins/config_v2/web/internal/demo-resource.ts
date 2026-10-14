import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRawContributions } from "@plugins/framework/plugins/web-sdk/core";
import type {
  BrowserServe,
  BrowserServed,
} from "@plugins/framework/plugins/browser-server/core";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import {
  configScopes,
  configValues,
  type ConfigDescriptor,
  type ConfigV2Values,
} from "@plugins/config_v2/core";
import { ConfigV2 } from "./slots";
import { storePathOf } from "./store-path";

/** What the serve function served, kept to `notify()` later. */
interface ServedConfig {
  scopes: { notify(params?: Record<string, never>): void };
  values: { notify(params?: { path: string; scopeId?: string }): void };
  /** The documents the server last answered from — a change since is what a notify announces. */
  docs: ReadonlyMap<string, ConfigV2Values>;
}

/**
 * Config inside a demo scope (`Demo.Resource`): every web-registered
 * descriptor's code `defaults`, as if the user had configured nothing.
 *
 * - `config-v2.scopes` — every registered storePath → `[]` (no scope has a
 *   document of its own), so every `useConfig` reads the base document;
 * - `config-v2.values` — `{ path }` (no or `""` scopeId) → a copy of that
 *   descriptor's `defaults`. An unregistered path, or any scopeId, throws (the
 *   reader sees `loader-failed`).
 *
 * `conflicts`, `tiers`, `raw-file` and the rest stay unserved: a demo surface
 * reading them fails loudly. Both values are `"notified"`: a lazy plugin's
 * registration arriving later re-renders this hook, and the effect below
 * notifies — the loaders read the registrations through a ref, so the scope's
 * server is never rebuilt for it.
 */
export function useConfigDemoServe(): (
  s: BrowserServe,
) => readonly BrowserServed[] {
  // Raw: the full descriptor, `defaults` included (`useConfigRegistrations`
  // withholds them on purpose — this is the one reader that answers with them).
  const raw = useRawContributions(ConfigV2.WebRegister);
  const docs = useMemo(() => {
    const out = new Map<string, ConfigV2Values>();
    for (const c of raw) {
      const path = storePathOf(c);
      if (path !== null) {
        out.set(path, (c.descriptor as ConfigDescriptor).defaults);
      }
    }
    return out;
  }, [raw]);
  const docsRef = useLatestRef(docs);
  const served = useRef<ServedConfig | null>(null);

  const serve = useCallback(
    (s: BrowserServe): readonly BrowserServed[] => {
      const scopes = s.serveValue(configScopes, {
        source: "external",
        changes: "notified",
        loader: () =>
          Object.fromEntries([...docsRef.current.keys()].map((p) => [p, []])),
      });
      const values = s.serveValue(configValues, {
        source: "external",
        changes: "notified",
        loader: ({ path, scopeId }) => {
          if (scopeId !== undefined && scopeId !== "") {
            throw new Error(
              `config-v2 (demo): "${path}" has no document for scope "${scopeId}" — the demo serves code defaults only.`,
            );
          }
          const defaults = docsRef.current.get(path);
          if (defaults === undefined) {
            throw new Error(
              `config-v2 (demo): no descriptor is registered on web for "${path}".`,
            );
          }
          return { ...defaults };
        },
      });
      served.current = { scopes, values, docs: docsRef.current };
      return [scopes, values];
    },
    [docsRef],
  );

  useEffect(() => {
    const current = served.current;
    if (current === null || current.docs === docs) return;
    current.docs = docs;
    current.scopes.notify();
    for (const path of docs.keys()) current.values.notify({ path });
  }, [docs]);

  return serve;
}
