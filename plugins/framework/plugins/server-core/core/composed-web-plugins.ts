// Which web plugins THIS backend's composition loads in its browser — the
// dot-form plugin ids of its web registry, as its server registry states them
// (`composition.webPlugins`, rendered by codegen beside the entries).
//
// The server cannot see web slots, so what the browser registers reaches it as
// build-time data (codegen's post-web manifests: the apps, the themes). That
// data is ONE committed file per checkout, each entry tagged with the plugin
// that contributed it ({@link ComposedEntry}); a backend keeps the entries of
// the plugins its own composition loads ({@link composedOnly}). So a dev
// composition backend and a compiled release read the same file through the
// same filter — there is no per-composition copy to select, redirect or reclaim.
//
// Declared once, by the process root that knows which registry it booted
// (`bin/serve.ts`, `cli/run-exec.ts`), before the graph loads. A read before
// that throws rather than guessing: a host that boots these consumers without
// stating its composition would otherwise paint every app of the checkout.
// A browser or static host (`bootBrowserHost`) declares nothing: it renders no
// document head, so the readers (the theme head, the app-manifest routes) are
// never asked there — and if one is, it fails loudly instead of answering for
// the wrong composition. The setter stays off the core barrel, like
// `setBootMode`.

/** One entry of a post-web manifest, with the web plugin that contributed it. */
export interface ComposedEntry<T> {
  /** The contributing web plugin's dot-form id. */
  plugin: string;
  value: T;
}

let declared: ReadonlySet<string> | undefined;

/** Set by the process root, once, from the registry it booted. Never call it
 * from plugin code. */
export function declareComposedWebPlugins(
  webPlugins: readonly string[] | undefined,
): void {
  // The composition registries are gitignored and typed as main's, so one
  // written before registries stated their web plugins type-checks yet has no
  // `webPlugins` — and an empty set would paint no app and no theme, silently.
  if (!Array.isArray(webPlugins)) {
    throw new Error(
      "[composition] the server registry this process booted states no `composition.webPlugins` — " +
        "it predates the field; rebuild the composition (`./equin build --composition <id>`) to regenerate it",
    );
  }
  const next = new Set(webPlugins);
  if (
    declared !== undefined &&
    (declared.size !== next.size || [...next].some((p) => !declared!.has(p)))
  ) {
    throw new Error(
      "[composition] composed web plugins already declared with a different set; a process serves one composition",
    );
  }
  declared = next;
}

/** The web plugins this backend's composition loads in its browser. */
export function composedWebPlugins(): ReadonlySet<string> {
  if (declared === undefined) {
    throw new Error(
      "[composition] composedWebPlugins() read before the process declared its composition — " +
        "only a host that booted a composition registry (serve, exec) can answer what its browser loads",
    );
  }
  return declared;
}

const filtered = new WeakMap<readonly ComposedEntry<unknown>[], unknown[]>();

/**
 * The values of `entries` whose contributing plugin this composition's browser
 * loads, in manifest order. Memoized per manifest array (the set is fixed for
 * the process), so a per-request reader pays the filter once.
 */
export function composedOnly<T>(entries: readonly ComposedEntry<T>[]): T[] {
  let out = filtered.get(entries) as T[] | undefined;
  if (out === undefined) {
    out = keepComposed(entries, composedWebPlugins());
    filtered.set(entries, out);
  }
  return out;
}

/** The values of `entries` contributed by one of `plugins`, in order. */
export function keepComposed<T>(
  entries: readonly ComposedEntry<T>[],
  plugins: ReadonlySet<string>,
): T[] {
  return entries.filter((e) => plugins.has(e.plugin)).map((e) => e.value);
}
