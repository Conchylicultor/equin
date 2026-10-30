import {
  registeringPlugin,
  type Registration,
} from "@plugins/framework/plugins/server-core/core";

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
  /** Per-warmup wall-time budget (ms). Read by the boot-budget monitor. */
  budgetMs?: number;
}

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
