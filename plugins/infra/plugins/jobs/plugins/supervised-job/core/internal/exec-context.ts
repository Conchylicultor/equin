/**
 * Proof that the code holding it runs OUTSIDE a serving backend's event loop.
 *
 * Some work must never run on a backend's event loop: a 500 MB download, a
 * `uv sync`, anything that holds a host lock for minutes. A function that does
 * such work takes an `ExecContext` parameter, and the only places that can
 * produce one are the out-of-process contexts:
 *
 * - a supervised job's `run` body (`SupervisedRunContext.exec`), which runs in
 *   its own `./equin supervised-exec` child;
 * - a `./equin` CLI command (`cliExecContext`, exported from this
 *   plugin's `cli` barrel — a `server/` file cannot import a `cli` barrel, so a
 *   request handler has no spelling of it).
 *
 * Both mints also hand the context its host admission (`admit`), so work that
 * demands an `ExecContext` is admitted to the host through it.
 *
 * A request handler has none, so it cannot spell the call: the Chromium
 * regression (a thumbnail render downloading 150 MB on the event loop) is a
 * type error rather than a review comment.
 *
 * The brand is a module-private `unique symbol`, so nothing outside this file
 * can construct the type by hand.
 */
declare const execContextBrand: unique symbol;

export interface ExecContext {
  readonly [execContextBrand]: true;
  /** Which out-of-process context minted it — for logs and error messages. */
  readonly origin: "supervised-run" | "cli";
  /**
   * Run `fn` under ONE background unit of host admission
   * (`withHostGrant({ lane: "background", max: 1 })`), so a big install or
   * download yields to builds and interactive work.
   *
   * Carried by the context rather than imported by the work that needs it:
   * `withHostGrant` is a `server` barrel, which host-only code below `server/`
   * (the `infra/deps` engine) cannot reach. Every mint fills it, so a caller
   * holding an `ExecContext` cannot forget admission.
   */
  readonly admit: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * The one mint of an `ExecContext`. Not exported from any barrel: the server
 * half (the supervised run body) and the `cli` half (`cliExecContext`) each
 * pass the host admission their runtime can reach.
 */
export function mintExecContext(
  origin: ExecContext["origin"],
  admit: ExecContext["admit"],
): ExecContext {
  // The brand exists only in the type system; at runtime it is a plain object.
  return { origin, admit } as ExecContext;
}
