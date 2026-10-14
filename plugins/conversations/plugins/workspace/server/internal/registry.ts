import { basename, dirname, join } from "node:path";
import type { Registration } from "@plugins/framework/plugins/server-core/core";
import type { EnqueueTx } from "@plugins/infra/plugins/jobs/server";
import type { WorkspaceKind, WorkspaceSpec } from "../../core";

/**
 * What a workspace adds to the agent's launch: extra CLI arguments, appended
 * after the runtime's own, and a `--settings` fragment merged into the
 * runtime's one settings object (a key both set throws).
 */
export interface LaunchFragment {
  argv: readonly string[];
  settings: Record<string, unknown>;
}

/** One attempt's workspace: where it is, and what it was launched as. */
export interface WorkspaceAt<S extends WorkspaceSpec = WorkspaceSpec> {
  attemptId: string;
  path: string;
  spec: S;
}

/** Whether a conversation's workspace can take a `claude --resume`. */
export type Resumability =
  { kind: "ok" } | { kind: "missing"; message: string };

type SpecOf<K extends WorkspaceKind> = Extract<WorkspaceSpec, { kind: K }>;

/**
 * One kind of workspace — where a conversation runs, and every step of its
 * life that depends on that. Orthogonal to the runtime (tmux | api), which
 * only ever sees the cwd and the {@link LaunchFragment}.
 */
/** What a launch adds per session, beyond the workspace itself. */
export interface LaunchContext {
  conversationId: string;
}

export interface WorkspaceImpl<K extends WorkspaceKind = WorkspaceKind> {
  readonly kind: K;
  /**
   * Validates (and normalizes) a NEW attempt's spec, before anything is
   * written: an unknown scratch profile, or an input its profile refuses,
   * throws here. What it returns is what the attempt row stores.
   */
  parseSpec(spec: SpecOf<K>): SpecOf<K>;
  /**
   * The directory every workspace of this kind lives DIRECTLY under. A
   * workspace's path is `<root>/<attemptId>` — derived by the registry, never
   * spelled by an impl, so `basename(path) === attemptId` holds for every kind.
   */
  root(): Promise<string>;
  /** Writes on the launch's transaction, committing with the new attempt. */
  onCommit(tx: EnqueueTx, at: WorkspaceAt<SpecOf<K>>): Promise<void>;
  /**
   * Makes the workspace exist, before the first session starts in it. Runs in
   * the durable spawn job, so it must be idempotent.
   */
  prepare(at: WorkspaceAt<SpecOf<K>>, signal: AbortSignal): Promise<void>;
  /** What runs once the launch has committed (fire-and-forget by the caller). */
  onFinish(at: WorkspaceAt<SpecOf<K>>): Promise<void>;
  /** What every session started in this workspace adds to its launch. */
  launch(at: WorkspaceAt<SpecOf<K>>, ctx: LaunchContext): LaunchFragment;
  /**
   * Whether a session can be resumed here. Side-effect free: a refusal must
   * leave the conversation exactly as it was.
   */
  checkResumable(at: WorkspaceAt<SpecOf<K>>): Resumability;
}

const registry = new Map<WorkspaceKind, WorkspaceImpl>();

function get<K extends WorkspaceKind>(kind: K): WorkspaceImpl<K> {
  const impl = registry.get(kind);
  if (!impl) throw new Error(`Unknown workspace kind "${kind}"`);
  return impl as unknown as WorkspaceImpl<K>;
}

export const Workspace = {
  /**
   * Returns a {@link Registration} token, like `Runtime.define`: the actual
   * `registry.set` (and the duplicate-kind guard) fire when the framework
   * invokes `.register()` during the plugin register phase.
   */
  define<K extends WorkspaceKind>(impl: WorkspaceImpl<K>): Registration {
    return {
      register() {
        if (registry.has(impl.kind)) {
          throw new Error(`Workspace kind "${impl.kind}" already registered`);
        }
        registry.set(impl.kind, impl as unknown as WorkspaceImpl);
      },
    };
  },
  get,
  all(): WorkspaceImpl[] {
    return Array.from(registry.values());
  },
  /** Where the attempt's workspace of `kind` lives: `<root>/<attemptId>`. */
  async pathFor(kind: WorkspaceKind, attemptId: string): Promise<string> {
    return join(await get(kind).root(), attemptId);
  },
  /**
   * The inverse of {@link Workspace.pathFor}: which registered kind's workspace
   * `path` is, and for which attempt — or `"none"` for any other directory (the
   * repo root, /tmp, a hand-edited path), which is not a workspace this system
   * created and must never be adopted as an attempt.
   */
  async resolvePath(
    path: string,
  ): Promise<{ kind: WorkspaceKind; attemptId: string } | "none"> {
    const parent = dirname(path);
    for (const impl of registry.values()) {
      if (parent === (await impl.root())) {
        return { kind: impl.kind, attemptId: basename(path) };
      }
    }
    return "none";
  },
};

/**
 * Sets `impl` as its kind's workspace, replacing any registered one — for a
 * test, which runs without the plugin register phase and may share the module
 * with other suites.
 */
export function installWorkspaceImpl<K extends WorkspaceKind>(
  impl: WorkspaceImpl<K>,
): void {
  registry.set(impl.kind, impl as unknown as WorkspaceImpl);
}

/** Clears the registry. */
export function resetWorkspaceRegistry(): void {
  registry.clear();
}
