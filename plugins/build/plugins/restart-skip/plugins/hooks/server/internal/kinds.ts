import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import type { BootInput } from "../../core";

/**
 * What a backend does when it adopts a deploy rather than being restarted
 * for it: every per-process memo that names "the deploy this process came
 * from" moves to the new one, exactly as a fresh boot would have read it.
 */
export interface AdoptHook {
  /** What it re-reads, in words. */
  what: string;
  adopt(deploy: { commit: string }): void | Promise<void>;
}

export const RestartSkip = {
  /** A `BootInput` (core): files a boot reads once and holds. */
  BootInput: defineServerContribution<BootInput>("restart-skip.boot-input", {
    docLabel: (p) => p.what,
  }),
  Adopted: defineServerContribution<AdoptHook>("restart-skip.adopted", {
    docLabel: (p) => p.what,
  }),
};
