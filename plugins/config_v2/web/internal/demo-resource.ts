import { useEffect, useMemo, useState } from "react";
import { useRawContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { BrowserServe } from "@plugins/framework/plugins/browser-server/core";
import type { DemoBackend } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/core";
import {
  appScopeId,
  computeHash,
  configScopes,
  configValues,
  createMemoryConfigStore,
  normalizeCollectionItems,
  readonlyProxy,
  readTypedConfig,
  scopeAppId,
  setConfigField,
  type ConfigDescriptor,
  type ConfigProxy,
  type ConfigV2Values,
  type GitLayerDocument,
  type JsonValue,
} from "@plugins/config_v2/core";
import { ConfigV2 } from "./slots";
import { storePathOf } from "./store-path";

/** The committed config layer, storePath → its resolved git-layer document. */
export type GitLayer = Readonly<Record<string, GitLayerDocument>>;

/** Where a demo scope's git layer comes from — the bundle, or a test's fixture. */
export type LoadGitLayer = () => Promise<GitLayer>;

/**
 * The git layer `./singularity build` bundles from the repo's `config/`
 * (codegen's `config-git-layer-gen.ts`), restricted to the DEPLOYED
 * composition's plugins and apps. It is not part of this plugin's artifact: the
 * import map points `@composition-config-layer` at the composition's own
 * registry artifact (`web-artifacts`' composition modules), so a deploy never
 * ships another composition's config. A dynamic import: fetched by the first
 * demo scope that reads config, never by the app.
 */
const loadBundledGitLayer: LoadGitLayer = () =>
  import("@composition-config-layer").then((m) => m.gitLayer);

/** What the serve function served, kept to `notify()` later. */
interface ServedConfig {
  scopes: { notify(params?: Record<string, never>): void };
  values: { notify(params?: { path: string; scopeId?: string }): void };
}

/** `""` and absent both name the base document (`configValues`' own rule). */
function scopeOf(scopeId: string | undefined): string | undefined {
  return scopeId === undefined || scopeId === "" ? undefined : scopeId;
}

/** One mount's config backend, and the one way its descriptor set changes. */
interface ConfigDemoState {
  backend: DemoBackend;
  /** A lazy plugin's registration arrived: re-read and notify both values. */
  setDescriptors(next: ReadonlyMap<string, ConfigDescriptor>): void;
}

/**
 * Builds one scope mount's backend — plain state, no React: the descriptor
 * set (replaced by `setDescriptors`), the in-memory user layer, the scopes a
 * write forked (each holding the base it was forked from as its origin), the
 * served values' notify handles.
 */
function createConfigDemoState(
  gitLayer: Promise<GitLayer>,
  initial: ReadonlyMap<string, ConfigDescriptor>,
): ConfigDemoState {
  let descriptors = initial;
  let served: ServedConfig | null = null;
  const user = createMemoryConfigStore();
  const forkOrigins = createMemoryConfigStore();
  const forkedScopes = new Map<string, Set<string>>();

  const descriptorOf = (path: string): ConfigDescriptor => {
    const d = descriptors.get(path);
    if (d === undefined) {
      throw new Error(
        `config-v2 (demo): no descriptor is registered on web for "${path}".`,
      );
    }
    return d;
  };
  // The origin a document resolves against, or null for a scope with no
  // document of its own (not a member: `useConfig` reads the base instead).
  const originOf = (
    layer: GitLayer,
    path: string,
    scopeId: string | undefined,
  ): ConfigProxy | null => {
    const committed = layer[path];
    if (scopeId === undefined) {
      return readonlyProxy(
        committed?.base ?? (descriptorOf(path).defaults as JsonValue),
      );
    }
    const appId = scopeAppId(scopeId);
    const scoped = appId === undefined ? undefined : committed?.scopes[appId];
    if (scoped !== undefined) return readonlyProxy(scoped);
    const fork = forkOrigins.proxy(path, scopeId);
    return fork.exists() ? fork : null;
  };
  const resolve = (
    layer: GitLayer,
    path: string,
    scopeId: string | undefined,
  ): { values: ConfigV2Values; origin: ConfigProxy } => {
    const descriptor = descriptorOf(path);
    const origin = originOf(layer, path, scopeId);
    if (origin === null) {
      throw new Error(
        `config-v2 (demo): "${path}" has no document for scope "${scopeId}".`,
      );
    }
    // The server's read path: the tier cascade, then list rows normalized
    // (an id-less row gets its deterministic `auto-` id — renderers key on it).
    const values = readTypedConfig(
      descriptor,
      origin,
      user.proxy(path, scopeId),
    );
    return {
      values: normalizeCollectionItems(
        values as Record<string, unknown>,
        descriptor.fields,
      ),
      origin,
    };
  };
  const membersOf = (layer: GitLayer, path: string): string[] => {
    const ids = new Set(Object.keys(layer[path]?.scopes ?? {}).map(appScopeId));
    for (const id of forkedScopes.get(path) ?? []) ids.add(id);
    return [...ids].sort();
  };

  const serve = (s: BrowserServe) => {
    const scopes = s.serveValue(configScopes, {
      source: "external",
      changes: "notified",
      loader: async () => {
        const layer = await gitLayer;
        return Object.fromEntries(
          [...descriptors.keys()].map((p) => [p, membersOf(layer, p)]),
        );
      },
    });
    const values = s.serveValue(configValues, {
      source: "external",
      changes: "notified",
      loader: async ({ path, scopeId }) =>
        resolve(await gitLayer, path, scopeOf(scopeId)).values,
    });
    served = { scopes, values };
    return [scopes, values];
  };

  // The demo's `setConfig`: a FULL document `{ ...current, [key]: value }`,
  // checked against the schema, written to the user layer under the hash of
  // the origin it was resolved against (so the cascade honours it). A scoped
  // write to a scope with no document of its own forks it first — the base as
  // it resolves now becomes that scope's origin, as on the server.
  const setField = implement(setConfigField, async ({ body }) => {
    const layer = await gitLayer;
    const path = body.storePath;
    const scopeId = scopeOf(body.scopeId);
    const descriptor = descriptors.get(path);
    if (descriptor === undefined) {
      throw new HttpError(400, `No descriptor for "${path}"`);
    }
    if (!(body.key in descriptor.fields)) {
      throw new HttpError(
        400,
        `No field "${body.key}" in "${descriptor.name}"`,
      );
    }
    if (scopeId !== undefined && originOf(layer, path, scopeId) === null) {
      const base = resolve(layer, path, undefined).values;
      forkOrigins.proxy(path, scopeId).write(base as JsonValue, null);
      const ids = forkedScopes.get(path) ?? new Set<string>();
      ids.add(scopeId);
      forkedScopes.set(path, ids);
      served?.scopes.notify();
    }
    const { values, origin } = resolve(layer, path, scopeId);
    const next = normalizeCollectionItems(
      { ...values, [body.key]: body.value },
      descriptor.fields,
    );
    const parsed = descriptor.schema.safeParse(next);
    if (!parsed.success) {
      throw new HttpError(
        400,
        `Invalid value for "${body.key}" in "${descriptor.name}": ` +
          parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
      );
    }
    const originDoc = origin.read();
    user
      .proxy(path, scopeId)
      .write(
        next as JsonValue,
        originDoc === null ? null : computeHash(originDoc.content),
      );
    served?.values.notify(scopeId === undefined ? { path } : { path, scopeId });
  });

  return {
    backend: { serve, routes: [[setConfigField.route, setField]] },
    setDescriptors(next) {
      if (next === descriptors) return;
      descriptors = next;
      if (served === null) return;
      served.scopes.notify();
      for (const path of next.keys()) served.values.notify({ path });
    },
  };
}

/**
 * Config inside a demo scope (`Demo.Resource`): the server's tier cascade over
 * two browser layers, so a demo surface reads exactly what a fresh user of the
 * committed repo would — and can change it.
 *
 * - **Git layer** (read-only): the committed `config/` documents bundled by the
 *   build (`override ⊕ origin`, `@app` scopes resolved over it); a path the
 *   committed layer does not arrange reads its code `defaults` (its generated
 *   origin, by construction).
 * - **User layer** (`createMemoryConfigStore`): what the demo writes, through
 *   the scope's own `POST /api/config-v2/set-field`. It lives as long as the
 *   scope's mount — a remount or reload is the committed state again.
 *
 * `config-v2.scopes` lists every web-registered storePath with the scopes it
 * has a document for (the git layer's `@app` scopes plus any a demo write
 * forked). `config-v2.values` resolves `readTypedConfig(descriptor, git, user)`
 * for a `{ path }` or a member `{ path, scopeId }`; an unregistered path or a
 * non-member scope throws (the reader sees `loader-failed`). `conflicts`,
 * `tiers`, `raw-file` and the other settings-app keys stay unserved, and so do
 * the settings app's other write endpoints (refused like any unserved `/api`).
 *
 * Both values are `"notified"`: a lazy plugin's registration arriving later
 * re-renders this hook and the effect below notifies; a write notifies its own
 * tuple. Every input is read through a ref, so the scope's server is never
 * rebuilt for either.
 */
export function useConfigDemoBackend(
  loadGitLayer: LoadGitLayer = loadBundledGitLayer,
): DemoBackend {
  // Raw: the full descriptor, `defaults` included (`useConfigRegistrations`
  // withholds them on purpose — this is the one reader that answers with them).
  const raw = useRawContributions(ConfigV2.WebRegister);
  const descriptors = useMemo(() => {
    const out = new Map<string, ConfigDescriptor>();
    for (const c of raw) {
      const path = storePathOf(c);
      if (path !== null) out.set(path, c.descriptor as ConfigDescriptor);
    }
    return out;
  }, [raw]);
  // Once per mount: the scope's config backend lives exactly as long as it.
  const [state] = useState(() =>
    createConfigDemoState(loadGitLayer(), descriptors),
  );
  useEffect(() => {
    state.setDescriptors(descriptors);
  }, [state, descriptors]);
  return state.backend;
}
