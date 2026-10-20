/** A read of a key nothing in the demo serves (the browser server answers it `loader-failed`). */
export class DemoMissingError extends Error {
  readonly key: string;
  readonly params: unknown;
  constructor(key: string, params: unknown) {
    super(`demo: "${key}" has no answer for ${describe(params)}.`);
    this.name = "DemoMissingError";
    this.key = key;
    this.params = params;
  }
}

function describe(params: unknown): string {
  try {
    return JSON.stringify(params) ?? String(params);
  } catch (err) {
    if (err instanceof TypeError) return String(params);
    throw err;
  }
}

/**
 * A demo: the app it shows, the route it opens at, and the browser host its
 * story is served from. Declared by the app's owner (`apps/<app>/plugins/demo`),
 * so nothing generic names a scenario.
 */
export interface DemoScenario {
  id: string;
  /** The `Apps.App` id the demo renders (an `<AppEmbed app>`). */
  app: string;
  /** The app-relative route it opens at (`/c/<id>`). */
  route: string;
  /**
   * The scenario's browser host: a Web Worker running real server code on an
   * in-browser database seeded with the scenario's story
   * (`import("@browser-host/<plugin path>")`). The keys it serves are answered
   * by it; every other key by the `Demo.Resource` backends. Absent: only the
   * backends answer.
   */
  host?: () => Promise<{ start(): Worker }>;
}
