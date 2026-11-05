import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The unsettled-boot marks: one empty file per worktree whose latest boot has
 * not been seen to settle (become ready, or exit). A backend marks itself right
 * after its `start` line; the boot watchdog (main) clears a mark once it read
 * that worktree's boot channel and found it settled. So the watchdog reads the
 * few worktrees that can hold a wedge — every mark, beside every backend the
 * gateway runs — instead of every worktree's `boot.jsonl` each minute.
 *
 * `.indexed` is the watchdog's stamp that the marks are complete (it swept
 * every worktree once to write the ones no backend wrote: boots from before
 * the marks existed). `cache`: deleted, the stamp goes with it and the next
 * tick sweeps every worktree once to rebuild them.
 */
export const bootUnsettledDir = defineDataDir({
  kind: "cache",
  name: "boot-unsettled",
  owner: "debug/boot-events",
  description:
    "One empty mark per worktree whose latest boot has not been seen to become ready or exit, so the boot watchdog reads only those — rebuilt by one full sweep when deleted",
  reclaim: { kind: "safe" },
});

export default [bootUnsettledDir];
