import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { resolveFieldStorage } from "./internal/storage";
export type {
  StorageColumnFor,
  StorageColumnBuilder,
  FieldStorageContribution,
} from "./internal/storage";
// `Fields` is composed in fields.ts (Storage + ValueTextCast) so the barrel
// re-exports a single capability namespace without any merge logic of its own.
export { Fields } from "./internal/fields";
export { resolveFieldValueTextCast } from "./internal/value-cast";
export type {
  ValueTextCast,
  FieldValueTextCastContribution,
  FieldValueTextRead,
} from "./internal/value-cast";

export default {
  description:
    "Server-owned field-capability library: the Fields.Storage / Fields.ValueTextCast tokens, their resolvers (resolveFieldStorage / resolveFieldValueTextCast — the latter answering a TEXT-stored value's cast AND the filter-language domain it reads in), and the storage eager self-registering index. A graph sink — never imports a capability barrel.",
} satisfies ServerPluginDefinition;
