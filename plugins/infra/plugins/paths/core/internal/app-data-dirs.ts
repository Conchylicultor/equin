// Relative sibling import: this file lives INSIDE the `paths` plugin, so the
// `@plugins/infra/plugins/paths/core` alias would cycle back through the barrel
// that re-exports it.
import type { DataDirSpec } from "./data-dir";

// The rules behind `paths:app-data-dirs`, as PURE functions over literals.
//
// The rule they enforce: each app owns exactly one data dir, `apps/<app>/`, and
// everything that app keeps durably — its own content and each of its
// sub-plugins' — lives inside it. The type system carries the first half:
// `defineDataDir` refuses the `apps` kind, so an `apps/*` dir can only be spelled
// through `defineAppDataDir(app, …)`. What a type cannot see is WHERE that call
// sits and WHICH app it names — `{ id: "prototype-history" }` is a perfectly
// good `AppIdentity` — so the rest is a check that pairs every declaration with
// the plugin that made it.
//
// The miss that motivated this: an agent designing prototype version history
// proposed `apps/prototype-history` beside `apps/prototypes`, and nothing
// flagged it. Rule A is the answer to that; rule B closes the `state/` escape
// route beside it; C and D keep the pairing itself honest.
//
// Pure so every rule is tested on hand-built literals, the way
// `legacy-layout.test.ts` tests the migration planner. The check supplies the
// facts: which `data-dirs/index.ts` default-exported which spec (by calling
// each generated entry's loader itself), and where the declaring calls sit.

/** One declaration as the registry cannot see it: paired with the plugin that exported it. */
export interface DataDirDeclaration {
  /** The collected entry's plugin path, e.g. `apps/plugins/prototypes`. */
  pluginPath: string;
  spec: DataDirSpec;
}

/** A declaring call site found by grep (`grepCode`'s `CodeMatch` shape). */
export interface DeclarationCallSite {
  /** Repo-relative file path. */
  path: string;
  /** 1-based line. */
  line: number;
  /** The original line text. */
  text: string;
}

/**
 * The owner a declaration made by `pluginPath` must carry: the path with every
 * `/plugins/` segment removed — `apps/plugins/prototypes/plugins/files` →
 * `apps/prototypes/files`. The same spelling every plugin doc uses, and the one
 * all existing declarations already followed by convention.
 */
export function ownerForPluginPath(pluginPath: string): string {
  return pluginPath.split("/plugins/").join("/");
}

/**
 * The app whose subtree `pluginPath` sits in — `apps/plugins/<x>` or anything
 * below it — or `null` when the plugin belongs to no app.
 */
export function appOfPluginPath(pluginPath: string): string | null {
  return /^apps\/plugins\/([^/]+)(?:\/|$)/.exec(pluginPath)?.[1] ?? null;
}

/** The plugin path that must declare `apps/<app>`. */
export function appRootPluginPath(app: string): string {
  return `apps/plugins/${app}`;
}

/** `file-explorer` → `fileExplorerDir`, the conventional name of an app's dir constant. */
function appDirConst(app: string): string {
  return `${app.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}Dir`;
}

function appDataDirsFile(app: string): string {
  return `plugins/${appRootPluginPath(app)}/data-dirs/index.ts`;
}

/**
 * Rules A–C over every (declaring plugin, spec) pair, as offender lines.
 *
 * A declaration appearing under two entries (one plugin re-exporting another's
 * `DataDir` in its default export) is two pairs, and each is judged on its own
 * — so the foreign appearance fails C (and A, for an app dir). That is the
 * intent: a plugin's default export lists the dirs IT declares, and the
 * registry is what everyone else imports from.
 */
export function evaluateDataDirDeclarations(
  declarations: readonly DataDirDeclaration[],
): string[] {
  const offenders: string[] = [];
  const sorted = [...declarations].sort(
    (a, b) =>
      `${a.spec.kind}/${a.spec.name}`.localeCompare(
        `${b.spec.kind}/${b.spec.name}`,
      ) || a.pluginPath.localeCompare(b.pluginPath),
  );

  for (const { pluginPath, spec } of sorted) {
    const key = `${spec.kind}/${spec.name}`;
    const inApp = appOfPluginPath(pluginPath);

    // ── A. An app's dir is declared by that app's root, and nobody else. ──
    if (spec.kind === "apps") {
      const expected = appRootPluginPath(spec.name);
      if (pluginPath !== expected) {
        if (inApp !== null && inApp !== spec.name) {
          offenders.push(
            `${key} is declared by ${pluginPath}, which is inside app "${inApp}" — an app owns exactly ONE data dir, ` +
              `so everything ${inApp} keeps durably goes inside apps/${inApp}. Delete this declaration and use ` +
              `${appDirConst(inApp)}.subdir("${spec.name}") from ${appDataDirsFile(inApp)} instead.`,
          );
        } else if (inApp === spec.name) {
          offenders.push(
            `${key} is declared by ${pluginPath}, a sub-plugin of app "${spec.name}". An app's one data dir is declared ` +
              `at the app's ROOT: move the defineAppDataDir call to ${appDataDirsFile(spec.name)} and ` +
              `import it from there (a sub-plugin that needs its own space takes ${appDirConst(spec.name)}.subdir("<area>")).`,
          );
        } else {
          offenders.push(
            `${key} is declared by ${pluginPath}, but an apps/<app> dir is declared only by its app's root plugin — ` +
              `${appDataDirsFile(spec.name)}, via defineAppDataDir(<app>, …). If "${spec.name}" is not an ` +
              `app, this is not app content: declare it with defineDataDir under state/ (the only copy of something) or ` +
              `cache/ (re-derivable).`,
          );
        }
      }
    }

    // ── B. An app's durable data lives in its app dir. ──
    //
    // Only `reclaim: never` — the only-copy class. A cache the app can re-derive
    // (`cache/prototypes-thumbnails`) is not the app's content and may sit
    // outside; putting it inside the app dir would make it look un-reclaimable.
    if (
      inApp !== null &&
      spec.kind !== "apps" &&
      spec.reclaim.kind === "never"
    ) {
      offenders.push(
        `${key} (declared by ${pluginPath}) is durable data of app "${inApp}" (reclaim: never), and durable data of ` +
          `app ${inApp} belongs in apps/${inApp} — delete this declaration and use ` +
          `${appDirConst(inApp)}.subdir("${spec.name}") from ${appDataDirsFile(inApp)}. ` +
          `(Data the app can re-derive may stay outside: declare it under cache/ with a reclaimable policy.)`,
      );
    }

    // ── C. `owner` is the declaring plugin, not free text. ──
    const owner = ownerForPluginPath(pluginPath);
    if (spec.owner !== owner) {
      offenders.push(
        `${key} is exported by ${pluginPath}/data-dirs but carries owner "${spec.owner}" — the owner is the declaring ` +
          `plugin's path with /plugins/ removed: "${owner}". If this DataDir is another plugin's, do not list it in this ` +
          `plugin's data-dirs default export; import it where you use it instead.`,
      );
    }
  }
  return offenders;
}

/**
 * A real-code CALL of either declaring function. `grepCode` masks comments,
 * strings and regex literals before this runs, so prose that names the
 * functions — this sentence included — is never a call site.
 */
export const DECLARATION_CALL_PATTERN = /\bdefine(?:App)?DataDir\s*\(/;

/** The one file a declaration may be made in: a plugin's collected `data-dirs/index.ts`. */
const DATA_DIRS_INDEX = /^plugins\/(?:.+\/)?data-dirs\/index\.ts$/;

/**
 * Rule D over grep hits: a declaring call outside a `data-dirs/index.ts` is
 * invisible to codegen's collection, so the manifest a backend publishes and
 * the audit's registry both miss it until some code path happens to import it
 * — and rules A–C cannot pair it with a plugin at all.
 *
 * Exempt: tests (a test declaring its own fixture dir is being hermetic) and
 * the `paths` plugin itself (the owner of the primitive — its definitions and
 * docblocks).
 */
export function evaluateDeclarationCallSites(
  sites: readonly DeclarationCallSite[],
): string[] {
  const offenders: string[] = [];
  for (const site of sites) {
    if (/\.test\.tsx?$/.test(site.path)) continue;
    if (site.path.startsWith("plugins/infra/plugins/paths/")) continue;
    if (DATA_DIRS_INDEX.test(site.path)) continue;
    offenders.push(
      `${site.path}:${site.line}: ${site.text.trim()} — a data dir is declared only in a plugin's ` +
        `data-dirs/index.ts (the collected dir codegen registers). Move this call into ` +
        `plugins/<owner>/data-dirs/index.ts, list it in that file's default export, and import the ` +
        `declaration from there.`,
    );
  }
  return offenders;
}
