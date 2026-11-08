// The store's layering, history and blob upgrade as pure functions over an
// in-memory blob — `store.ts` holds the blob, persists it and serializes writes;
// everything that decides WHERE a value lives and WHAT a write records is here,
// so it is tested without a keychain or a file.
//
// Layers: a `machine` namespace has one layer, the base. An `instance`
// namespace has the base (main's) plus one overlay per caller namespace: main
// reads and writes the base; any other namespace reads its overlay, falling
// through to the base, and writes only its overlay (a delete is a tombstone, so
// main's value does not reappear). A caller that names no namespace reads the
// base and may not write an instance namespace at all.

import { z } from "zod";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import {
  SECRET_HISTORY_LIMIT,
  SecretsError,
  SecretWriteSchema,
  type SecretMetadata,
  type SecretScope,
  type SecretWrite,
} from "@plugins/infra/plugins/secrets/core";

export const STORE_VERSION = 2;

const EntrySchema = z.object({
  /** `null` is a tombstone: deleted, its history kept. */
  value: z.string().nullable(),
  updatedAt: z.number(),
  history: z.array(SecretWriteSchema),
});
export type Entry = z.infer<typeof EntrySchema>;

/** One layer: namespace → key → entry. */
const LayerSchema = z.record(z.string(), z.record(z.string(), EntrySchema));
type Layer = z.infer<typeof LayerSchema>;

const BlobV2Schema = z.object({
  version: z.literal(STORE_VERSION),
  /** The base layer: every machine namespace, and main's instance values. */
  namespaces: LayerSchema,
  /** Caller namespace → its own layer of instance namespaces. */
  overlays: z.record(z.string(), LayerSchema),
});
export type StoreBlob = z.infer<typeof BlobV2Schema>;

const BlobV1Schema = z.object({
  version: z.literal(1),
  namespaces: z.record(
    z.string(),
    z.record(
      z.string(),
      z.object({ value: z.string(), updatedAt: z.number() }),
    ),
  ),
});

export function emptyBlob(): StoreBlob {
  return { version: STORE_VERSION, namespaces: {}, overlays: {} };
}

/**
 * The decrypted blob as the current version. A v1 blob (one layer, no history)
 * upgrades in place: its entries become the base with an empty history, and no
 * overlays. Any other shape throws — never a guess at what it held.
 */
export function upgradeBlob(parsed: unknown): StoreBlob {
  const v2 = BlobV2Schema.safeParse(parsed);
  if (v2.success) return v2.data;
  const v1 = BlobV1Schema.safeParse(parsed);
  if (!v1.success) {
    throw new Error(
      `secrets: store has unexpected shape (neither v1 nor v${STORE_VERSION}): ${v2.error.message}`,
    );
  }
  const namespaces: Layer = {};
  for (const [ns, keys] of Object.entries(v1.data.namespaces)) {
    const layer: Record<string, Entry> = {};
    for (const [key, e] of Object.entries(keys)) {
      layer[key] = { value: e.value, updatedAt: e.updatedAt, history: [] };
    }
    namespaces[ns] = layer;
  }
  return { version: STORE_VERSION, namespaces, overlays: {} };
}

/** Who asks, about which kind of namespace. */
export interface Access {
  readonly scope: SecretScope;
  /** The caller's own namespace claim, `null` when it named none. */
  readonly caller: string | null;
}

/** A write to an instance namespace from a caller that named no namespace. */
export class InstanceWriteRefusedError extends SecretsError {
  constructor(namespace: string) {
    super(
      `Secrets: "${namespace}" is instance-scoped — its base layer is main's, and a caller that names no namespace (no secrets caller header) may not write it. Write it from a backend, which writes its own namespace's layer.`,
    );
    this.name = "InstanceWriteRefusedError";
  }
}

/** Does this caller own the base layer of an instance namespace? Main exactly — a composition namespace on main's checkout is not main. */
function isBaseOwner(caller: string | null): boolean {
  return caller === MAIN_WORKTREE_NAME;
}

/** The caller's overlay of an instance namespace, when it reads through one. */
function overlayOf(blob: StoreBlob, access: Access): Layer | undefined {
  if (access.scope !== "instance") return undefined;
  if (access.caller === null || isBaseOwner(access.caller)) return undefined;
  return blob.overlays[access.caller];
}

/** The entry the caller sees: its overlay's (a tombstone included), else the base's. */
export function readEntry(
  blob: StoreBlob,
  access: Access,
  namespace: string,
  key: string,
): Entry | undefined {
  return (
    overlayOf(blob, access)?.[namespace]?.[key] ??
    blob.namespaces[namespace]?.[key]
  );
}

export function readValue(
  blob: StoreBlob,
  access: Access,
  namespace: string,
  key: string,
): string | undefined {
  return readEntry(blob, access, namespace, key)?.value ?? undefined;
}

export function metadataOf(
  blob: StoreBlob,
  access: Access,
  namespace: string,
  key: string,
): SecretMetadata {
  const entry = readEntry(blob, access, namespace, key);
  if (entry === undefined) return { set: false, history: [] };
  if (entry.value === null) return { set: false, history: entry.history };
  return { set: true, updatedAt: entry.updatedAt, history: entry.history };
}

/** Every key with a value the caller sees: the base's, plus its overlay's, minus its tombstones. */
export function listKeys(
  blob: StoreBlob,
  access: Access,
  namespace: string,
): string[] {
  const merged = new Map<string, Entry>(
    Object.entries(blob.namespaces[namespace] ?? {}),
  );
  for (const [key, e] of Object.entries(
    overlayOf(blob, access)?.[namespace] ?? {},
  )) {
    merged.set(key, e);
  }
  return [...merged].filter(([, e]) => e.value !== null).map(([k]) => k);
}

/** Refuse a write to an instance namespace from a caller that named no namespace. */
function assertMayWrite(access: Access, namespace: string): void {
  if (access.scope === "instance" && access.caller === null) {
    throw new InstanceWriteRefusedError(namespace);
  }
}

/** The layer this caller's writes land in, created on demand (after {@link assertMayWrite}). */
function writeLayer(blob: StoreBlob, access: Access): Layer {
  if (
    access.scope === "machine" ||
    access.caller === null ||
    isBaseOwner(access.caller)
  ) {
    return blob.namespaces;
  }
  return (blob.overlays[access.caller] ??= {});
}

/**
 * Set (`value`) or delete (`null`) one entry in the caller's layer, appending
 * the write to its history (the last {@link SECRET_HISTORY_LIMIT}). `changed`
 * compares with the value the caller saw before — its overlay's or the base's.
 * Deleting what the caller does not see is no write. Answers whether the blob
 * changed (so the caller persists only then).
 */
export function applyWrite(
  blob: StoreBlob,
  access: Access,
  namespace: string,
  key: string,
  value: string | null,
  now: number,
): boolean {
  assertMayWrite(access, namespace);
  const seen = readEntry(blob, access, namespace, key)?.value ?? null;
  if (value === null && seen === null) return false;
  const target = writeLayer(blob, access);
  const own = target[namespace]?.[key];
  const write: SecretWrite = {
    at: now,
    op: value === null ? "delete" : "set",
    by: access.caller,
    changed: seen !== value,
  };
  const history = [...(own?.history ?? []), write].slice(-SECRET_HISTORY_LIMIT);
  (target[namespace] ??= {})[key] = { value, updatedAt: now, history };
  return true;
}
