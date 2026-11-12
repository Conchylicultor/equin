import {
  registeringPlugin,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";
import type { SourceSet } from "@plugins/packages/plugins/source-digest/core";

/**
 * A declared heavy boot warm-up. Deferred past serving-ready and drained in
 * the serving host's settled phase (`onSettled`) under a concurrency gate + heavy-read slot + macrotask
 * yield — never run eagerly from `onReady`.
 *
 * `defineWarmup` is the *declarative* contribution that makes "heavy boot work"
 * a structurally distinct, enforceable category (a `deferBootWork(fn)` called
 * from inside `onReady` would stay lint-invisible and couldn't carry `scope` as
 * a static property the executor reads).
 */
export interface WarmupSpec {
  /** Stable id → profiler span + budget-report dedup key. Must be unique. */
  name: string;
  /**
   * What this warm-up prepares and why, in one present-tense sentence a user
   * reads — not the code name or the mechanism (e.g. "Builds the plugin tree
   * so the first Studio visit opens instantly.").
   */
  description: string;
  /**
   * `host` ⇒ runs once per host: on the desktop, ONLY on the main backend —
   * the N×-worktree-redundancy killer for host-global corpora/indexes; on a
   * sole host (the browser), always. `worktree` ⇒ runs on every backend,
   * acting only on its own worktree state. The host answers (`WarmupHost`).
   */
  scope: "host" | "worktree";
  /**
   * The warm-up body. Awaited under the drain's heavy-read slot. A warm-up is
   * an OPTIMIZATION, never a correctness dependency — a throw is logged and the
   * drain continues. Consumers must work cold via
   * their own lazy on-demand refresh.
   */
  run: () => Promise<void>;
  /**
   * For a warm-up that re-derives stored state from its sources (a backfill
   * of an index every write already keeps fresh): the code the derivation
   * runs — keep each included module small, since everything it loads counts.
   * Such stored state only goes stale when that code changes, so the drain
   * runs the warm-up only when the code's digest differs from the one recorded
   * when it last succeeded against this database (`warmup_code_stamps`), and
   * records the new one once `run` resolves: once per change of the code, never
   * on a boot whose code is the code that derived the rows. A fresh database
   * has no stamp, so its first boot runs it. Called at drain time, after every
   * contribution is registered (a set may include contributed modules).
   *
   * Where the host cannot digest code (`WarmupHost.codeDigest` answers
   * `null`: a browser host has no source tree), the warm-up runs on every boot.
   */
  derivedFrom?: () => readonly SourceSet[];
  /**
   * Per-warmup budget (ms) on its own time. The executor stamps it on the
   * warm-up's `bg` span, which slow-ops judges it by (the one judge of a
   * warm-up). Omit it to be judged on `DEFAULT_WARMUP_BUDGET_MS`.
   */
  budgetMs?: number;
}

/**
 * The budget of a warm-up that declares none. Looser than a loader's bar:
 * warm-ups are the declared heavy deferred category (throttled, run after the
 * `onAllReady` barrier, one heavy-read slot each). It was boot-budget's
 * `warmupBudgetMs` default when that monitor judged warm-ups too.
 */
export const DEFAULT_WARMUP_BUDGET_MS = 2000;

/**
 * Module-load-time registry. Populated by `defineWarmup(...).register()` during
 * the framework's register phase (mounted by a consumer plugin via
 * `register: [warmupToken]`, exactly like `defineJob`). Drained once in the
 * settled phase, after the `onAllReady` barrier.
 */
export const warmupRegistry = new Map<string, WarmupSpec>();

/** The plugin that registered each warm-up (Background activity's "Declared
 * in"), or `null` when registered outside the framework's register phase. */
export const warmupDeclaredIn = new Map<string, string | null>();

/**
 * Declare a heavy boot warm-up. Returns a {@link Registration} that side-effects
 * into {@link warmupRegistry} at `register()` time — mirroring `defineJob`.
 * Mount it via `register: [<the returned token>]` on the consumer plugin's
 * `ServerPluginDefinition`.
 */
export function defineWarmup(spec: WarmupSpec): Registration {
  return {
    _kind: "warmup",
    _factory: "defineWarmup",
    _doc: { label: spec.name, detail: spec.description },
    register() {
      if (warmupRegistry.has(spec.name)) {
        throw new Error(`[warmup] duplicate warmup name: ${spec.name}`);
      }
      warmupRegistry.set(spec.name, spec);
      warmupDeclaredIn.set(spec.name, registeringPlugin());
    },
  };
}

/** A declared warm-up and the plugin that registered it. */
export interface RegisteredWarmup {
  spec: WarmupSpec;
  declaredIn: string | null;
}

/** Every registered warm-up, in registration order. */
export function listRegisteredWarmups(): RegisteredWarmup[] {
  return [...warmupRegistry.values()].map((spec) => ({
    spec,
    declaredIn: warmupDeclaredIn.get(spec.name) ?? null,
  }));
}
