import { useEffect, useSyncExternalStore } from "react";
import {
  transportScoped,
  useTransport,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import type { AssetPath, MachineFeature } from "../../core";
// `ASSET_PATH`: this module is the one reader of an AssetPath's path.
import { ASSET_PATH, unavailableMessage } from "../../core";

/**
 * What an element can load for an {@link AssetPath} in this subtree:
 * - `loading` — its bytes are being fetched through the transport;
 * - `ready` — `src` is what the element loads (the path itself on a server
 *   reachable by URL, a blob URL otherwise);
 * - `unavailable` — the route needs the computer and none is behind the
 *   transport (`message` says so in the one sentence every surface uses);
 * - `error` — the transport answered the fetch with a failure.
 */
export type AssetSrc =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly src: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

const LOADING: AssetSrc = Object.freeze({ kind: "loading" });

/** One fetched asset, held while any element shows it. */
interface Entry {
  refs: number;
  state: AssetSrc;
  readonly abort: AbortController;
}

/**
 * The assets a transport no URL reaches has fetched: each path's bytes as a
 * blob URL, shared by every element showing it and revoked once the last lets
 * go (`acquire`'s release). A `version` bumps on every change, the one
 * snapshot readers subscribe to.
 */
class BlobAssets {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly transport: Transport) {}

  readonly subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  };

  readonly snapshot = (): number => this.version;

  state(path: string): AssetSrc {
    return this.entries.get(path)?.state ?? LOADING;
  }

  /** Hold `path`'s blob URL, fetching it on the first hold. */
  acquire(path: string): () => void {
    let entry = this.entries.get(path);
    if (!entry) {
      const created: Entry = {
        refs: 0,
        state: LOADING,
        abort: new AbortController(),
      };
      this.entries.set(path, created);
      entry = created;
      void this.load(path, created);
    }
    entry.refs += 1;
    const held = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      // Deferred a microtask: an element that lets go and takes the same path
      // straight back (a remount, a re-keyed effect) keeps the blob.
      queueMicrotask(() => {
        if (held.refs > 0 || this.entries.get(path) !== held) return;
        this.entries.delete(path);
        held.abort.abort();
        if (held.state.kind === "ready") URL.revokeObjectURL(held.state.src);
      });
    };
  }

  private async load(path: string, entry: Entry): Promise<void> {
    let next: AssetSrc;
    try {
      const res = await this.transport.fetch(path, {
        signal: entry.abort.signal,
      });
      next = res.ok
        ? { kind: "ready", src: URL.createObjectURL(await res.blob()) }
        : { kind: "error", message: `HTTP ${res.status}` };
    } catch (err) {
      // Let go of before it answered: nothing holds the entry any more.
      if (entry.abort.signal.aborted) return;
      // No answer (the server went away mid-request): the element shows the
      // failure, as an `<img>` whose request failed would.
      next = {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (this.entries.get(path) !== entry) {
      // Released while the body was read: its URL has no holder.
      if (next.kind === "ready") URL.revokeObjectURL(next.src);
      return;
    }
    entry.state = next;
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/** One blob store per transport — used only by those no URL reaches. */
const blobAssets = transportScoped((transport) => new BlobAssets(transport));

/**
 * How `asset` loads on `transport` without fetching anything: `unavailable`
 * for a route that needs a computer the transport lacks, the path itself on a
 * server reachable by URL — or `null`: fetch it.
 */
function staticSrc(
  transport: Transport,
  needsMachine: MachineFeature | null,
  path: string,
): AssetSrc | null {
  if (needsMachine !== null && !transport.machine) {
    return { kind: "unavailable", message: unavailableMessage(needsMachine) };
  }
  return transport.servesUrls ? { kind: "ready", src: path } : null;
}

/**
 * What an element loads for each of `assets`, over the subtree's transport —
 * see {@link useAssetSrc}; for a surface that shows a set (a folder's images).
 */
export function useAssetSrcs(
  assets: readonly AssetPath[],
): readonly AssetSrc[] {
  const transport = useTransport();
  const store = blobAssets.of(transport);
  // Re-renders on every fetched asset; the states are read from the store.
  useSyncExternalStore(store.subscribe, store.snapshot);
  // The paths to fetch, as one string: the effect follows the paths, never the
  // identity of an array or of AssetPath objects a render rebuilt.
  const toFetch = assets
    .filter((a) => staticSrc(transport, a.needsMachine, a[ASSET_PATH]) === null)
    .map((a) => a[ASSET_PATH])
    .join("\n");
  useEffect(() => {
    if (toFetch === "") return;
    const releases = toFetch.split("\n").map((path) => store.acquire(path));
    return () => releases.forEach((release) => release());
  }, [store, toFetch]);
  return assets.map(
    (a) =>
      staticSrc(transport, a.needsMachine, a[ASSET_PATH]) ??
      store.state(a[ASSET_PATH]),
  );
}

/**
 * What an element loads for `asset` (`<img src>`, `<a href>`, `<iframe src>`),
 * over the subtree's transport: the path itself on a server reachable by URL
 * (the page's own), its bytes fetched through the transport and handed out as
 * a blob URL otherwise (an in-browser server — shared by every element showing
 * it, revoked when the last unmounts), `unavailable` for a route that needs
 * the computer when none is behind the transport.
 */
export function useAssetSrc(asset: AssetPath): AssetSrc {
  const [src] = useAssetSrcs([asset]);
  if (src === undefined) throw new Error("useAssetSrc: one asset, one answer");
  return src;
}
