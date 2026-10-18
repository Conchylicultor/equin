import { useCallback } from "react";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import { resolveTypeChain } from "@plugins/fields/core";
import { IDENTITY_CODEC, type ValueCodec } from "../core";
import { useFieldIdentities } from "./internal/use-field-identities";

/**
 * Per-type value-codec slot. A plain slot carrying one `ValueCodec` per field
 * type, keyed by `match` (the type token): it round-trips a custom column's
 * native cell/editor value ↔ its canonical text storage form. Mirrors the
 * `Filter` slot — a plain `defineSlot` payload resolved per type honoring the
 * `extends` chain (`useResolveValueCodec`). Types whose value is already a
 * string (text/enum) contribute nothing and fall back to `IDENTITY_CODEC`.
 */
const ValueCodecSlot = defineSlot<{ match: string; codec: ValueCodec }>({
  docLabel: (c) => c.match,
  // A companion here ships only in bundles that use its field type (see
  // `KeySpace`): the data-view primitive plus a plugin referencing the type.
  companions: { key: "match", space: "field-type" },
});

/** Resolve a field type id → its ValueCodec, honoring `extends`; identity default. */
export function useResolveValueCodec(): (typeId: string) => ValueCodec {
  const identities = useFieldIdentities();
  const contributions = ValueCodecSlot.useContributions();
  return useCallback(
    (typeId) => {
      const chain = resolveTypeChain(typeId, identities);
      for (const id of chain) {
        const c = contributions.find((x) => x.match === id);
        if (c) return c.codec;
      }
      return IDENTITY_CODEC;
    },
    [identities, contributions],
  );
}

export { ValueCodecSlot as ValueCodec };
