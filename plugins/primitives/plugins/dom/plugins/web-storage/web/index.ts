import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { WebStorageSlots } from "./slots";

export {
  defineStore,
  onStorageFailure,
  removeEntriesWhere,
  storageFailureReportSink,
  type LegacyKeys,
  type Store,
  type StoreRead,
  type StoreSpec,
  type StoreUsage,
  type StoreWrite,
  type StorageFailure,
  type WhenFull,
  type WriteFailureReason,
} from "./internal/store";
export { scanArea, type AreaBucket, type AreaScan } from "./internal/scan";
export { useStorageUsage } from "./internal/use-storage-usage";
export { WebStorageSlots } from "./slots";

export default {
  description:
    "The one door to browser storage (localStorage / sessionStorage): defineStore declares an owner — key prefix s:<owner>:, byte cap, TTL, what to do when full (evict-oldest for caches, refuse for what the user typed), a zod schema — and returns a typed read/write/remove/subscribe handle with one {v, ts} envelope. The caps of an area's owners sum under the browser's quota (asserted at declaration and statically by the budget-fits check), so no owner can fill storage for another. Every refused write and unreadable entry is announced (onStorageFailure); useStorageUsage and scanArea feed the health row; the no-raw-web-storage lint rule bans touching Web Storage anywhere else.",
  contributions: [Core.Root({ slot: WebStorageSlots.Root })],
  slots: WebStorageSlots,
} satisfies PluginDefinition;
