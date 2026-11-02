import { loaders } from "../internal/lazy-component";

/**
 * Load every lazy component's chunk declared so far — call it in a suite's
 * `beforeAll`, after the imports that declare them.
 *
 * A first render of a lazy component suspends until its chunk is imported,
 * which under a test runner means transforming that chunk's whole module graph
 * (react-markdown, Lexical, …) on demand. That is setup, not behaviour: left in
 * the render, it is spent inside a `findBy*` budget meant for the UI, and a
 * suite passes alone and times out under a loaded full run. Loaded here, the
 * first render resolves at once and the assertion measures only the UI.
 */
export async function loadLazyComponents(): Promise<void> {
  await Promise.all([...loaders].map((load) => load()));
}
