import {
  defineServerContribution,
  type ServerContribution,
  type ServerContributionToken,
} from "./contributions";

/**
 * A HOST SERVICE: one capability portable server code needs from whatever host
 * it runs on — the database driver, the job queue, blob storage — with exactly
 * one implementation per booted graph, chosen by which provider plugin the host
 * loads (a desktop backend's `machine/` half, a browser host's in-memory one).
 *
 * ```ts
 * export const DatabaseDriver = defineHostService<DbDriver>("database.driver");
 * // the provider plugin:
 * contributions: [DatabaseDriver.provide(pgDriver)],
 * // any consumer, after boot collected contributions:
 * DatabaseDriver.get();
 * ```
 *
 * Built on `defineServerContribution`, so the collected contribution carries
 * its `_pluginId` (a "two providers" error names both) and the docs facets list
 * providers like any other contribution. "Exactly one" is checked once, at boot,
 * by `assertHostServices()` — not at the first `get()`, which may come long
 * after a graph with no provider started serving.
 */
export interface HostService<T> {
  readonly id: string;
  /** The contribution a provider plugin lists in its `contributions`. */
  provide(impl: T): ServerContribution;
  /**
   * The one provider's implementation. Throws before boot has collected
   * contributions: a host service is read by code running in the booted graph,
   * never at module evaluation.
   */
  get(): T;
}

// Every service whose module has been evaluated. A service is "declared" once
// its module runs, so a host that loads a consumer must provide its services:
// `assertHostServices` checks every one of these, consumed or not.
const declared = new Map<string, ServerContributionToken<{ impl: unknown }>>();

// The providers of a process that runs booted code WITHOUT booting the graph — a
// headless `bun test`, whose preload names the desktop host's providers here
// (`provideHostServicesUnbooted`). Read only while nothing has been collected:
// once a graph boots, its own collected providers answer, exactly as at runtime.
let unbooted: readonly ServerContribution[] | null = null;

export function defineHostService<T>(id: string): HostService<T> {
  if (declared.has(id)) {
    throw new Error(
      `[host-service] "${id}" is defined twice — a host service id names one service.`,
    );
  }
  const token = defineServerContribution<{ impl: unknown }>(
    `host-service:${id}`,
    { docLabel: () => id },
  );
  declared.set(id, token);
  return {
    id,
    provide: (impl) => token({ impl }),
    get: () => {
      // Collected (a booted graph) answers; else the unbooted host's
      // providers, when it names one for this service; else nothing has
      // collected and nobody provided — read too early.
      const collected = token.getContributionsIfCollected();
      const unbootedProviders =
        collected === undefined && unbooted !== null
          ? token.from([{ contributions: unbooted }])
          : [];
      const providers =
        collected ??
        (unbootedProviders.length > 0 ? unbootedProviders : undefined);
      if (providers === undefined) {
        throw new Error(
          `[host-service] "${id}" read before boot collected contributions — host services are read after boot collects contributions, never at module evaluation.`,
        );
      }
      // `assertHostServices` has proven exactly one provider by the time any
      // booted code runs; a different count here means it was skipped.
      if (providers.length !== 1) throw providerCountError(id, providers);
      return providers[0]!.impl as T;
    },
  };
}

function providerCountError(
  id: string,
  providers: readonly { impl: unknown; _pluginId?: string }[],
): Error {
  if (providers.length === 0) {
    return new Error(
      `[host-service] "${id}" has no provider: no booted plugin contributes ${id}.provide(…). ` +
        `This host loads code that reads it, so it must also load a plugin providing it.`,
    );
  }
  const names = providers.map((p) => p._pluginId ?? "(unknown plugin)");
  return new Error(
    `[host-service] "${id}" has ${providers.length} providers (${names.join(", ")}) — a host boots exactly one implementation of each service.`,
  );
}

/**
 * Name the host's providers for a process that runs graph code WITHOUT booting
 * the graph: the `bun test` preload (the desktop host's machine halves'
 * contributions) and a check that runs booted code headless (the migration
 * dry-run's log persistence). Until some
 * suite boots a graph (whose collected providers then answer), every
 * `HostService.get()` reads its provider from these, with the same
 * exactly-one rule.
 */
export function provideHostServicesUnbooted(
  providers: readonly ServerContribution[],
): void {
  unbooted = providers;
}

/** Forget every declared service — test support (`core/testing`), so a suite's
 *  services do not leak into the next suite's boot asserts in one bun process. */
export function clearHostServices(): void {
  declared.clear();
}

/**
 * Fail boot for any declared host service with zero or two-plus providers,
 * naming the service and the providing plugins. Run right after
 * `collectContributions`, before any phase hook can read a service.
 */
export function assertHostServices(): void {
  const problems: string[] = [];
  for (const [id, token] of declared) {
    const providers = token.getContributions();
    if (providers.length !== 1)
      problems.push(providerCountError(id, providers).message);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}
