import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { SourceSet } from "@plugins/packages/plugins/source-digest/core";
import type { WarmupSpec } from "./registry";

/**
 * How this host admits warm-ups — a host's answer, never a guess from its
 * namespace (`isMain()` is false in a browser host, whose composition name is
 * its namespace, so reading it there would skip every `host` warm-up silently).
 *
 * The desktop's provider (`warmup#machine`) runs a `host`-scoped warm-up on
 * main only (N worktree backends share the machine) and admits each through
 * the host-wide heavy-read slot. A sole host — one backend, no neighbours
 * (`warmup/plugins/sole-host`, the browser composition) — runs every scope and
 * has no slot to take.
 */
export interface WarmupHostImpl {
  /** Whether a warm-up of this scope runs on this host. */
  runs(scope: WarmupSpec["scope"]): boolean;
  /** Run one warm-up body under the host's admission. */
  withSlot<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * The digest of the code these source sets load (a warm-up's
   * `derivedFrom`), or `null` when this host cannot digest code — then such a
   * warm-up runs on every boot. Throws when the digest cannot vouch for the
   * code (an unresolvable import): the drain reports it as the warm-up's
   * failure, and nothing is skipped on a digest nobody computed.
   */
  codeDigest(sets: readonly SourceSet[]): Promise<string | null>;
}

export const WarmupHost = defineHostService<WarmupHostImpl>("warmup.host");
