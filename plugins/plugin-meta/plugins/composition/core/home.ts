/**
 * Which app a deployed composition lands on at bare `/` — resolved from its
 * manifest's `home` against the apps its bundle actually holds.
 *
 * The ONE answer both `composition-closure` (are the manifests valid?) and
 * registry codegen (what goes into the web registry?) compute, so the two can
 * never disagree about a composition's homepage. Pure: the caller reads the
 * declared apps off disk (codegen's `readDeclaredApps`) and resolves the bundle.
 */
export type CompositionHome =
  /** `home` names an app whose shell is in the bundle. */
  | { kind: "app"; appId: string }
  /** No home: the bundle holds no app, or the composition is not deployed. */
  | { kind: "none" }
  | { kind: "error"; reason: CompositionHomeError; message: string };

export type CompositionHomeError =
  /** A deployed composition's bundle holds apps but `home` is empty. */
  | "missing"
  /** `home` names no `defineApp` id in the checkout. */
  | "not-an-app"
  /** `home` names a real app whose shell this bundle does not hold. */
  | "not-in-bundle"
  /** `home` is set but the bundle holds no app at all. */
  | "home-without-apps";

export function resolveCompositionHome(opts: {
  /** Every declared app, by app id → the plugin (dot id) whose core declares it. */
  apps: ReadonlyMap<string, { plugin: string }>;
  /** The composition's resolved hard closure (dot-form plugin ids). */
  bundle: ReadonlySet<string>;
  /** The manifest's `home` (`""` = none). */
  home: string;
  /**
   * Whether this composition is DEPLOYED, so something must own its `/`: a
   * product row, a served row, or any composition actually being built. An
   * inspection lens (a subsystem) may leave `home` empty even when its bundle
   * reaches an app; a home it does set must still be valid.
   */
  deployed: boolean;
}): CompositionHome {
  const { apps, bundle, home, deployed } = opts;
  const bundleApps = [...apps]
    .filter(([, a]) => bundle.has(a.plugin))
    .map(([id]) => id)
    .sort();
  const held = bundleApps.length > 0 ? bundleApps.join(", ") : "none";
  if (home === "") {
    if (bundleApps.length === 0 || !deployed) return { kind: "none" };
    return {
      kind: "error",
      reason: "missing",
      message: `declares no \`home\`, but bundles the apps ${held} — name the one that owns \`/\`.`,
    };
  }
  const app = apps.get(home);
  if (!app) {
    return {
      kind: "error",
      reason: "not-an-app",
      message: `\`home: "${home}"\` names no app (no \`defineApp({ id: "${home}" })\`). Known apps: ${[...apps.keys()].sort().join(", ")}.`,
    };
  }
  if (bundleApps.length === 0) {
    return {
      kind: "error",
      reason: "home-without-apps",
      message: `\`home: "${home}"\` is set, but the bundle holds no app — clear it.`,
    };
  }
  if (!bundle.has(app.plugin)) {
    return {
      kind: "error",
      reason: "not-in-bundle",
      message: `\`home: "${home}"\` is not in the bundle (its shell ${app.plugin} is not bundled). Bundled apps: ${held}.`,
    };
  }
  return { kind: "app", appId: home };
}
