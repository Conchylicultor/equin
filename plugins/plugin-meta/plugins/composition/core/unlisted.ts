/**
 * Which bundled apps a deployed composition keeps out of its launchers —
 * resolved from its manifest's `unlisted` against the apps its bundle holds.
 *
 * An app lands in a bundle for one of two reasons: the composition asks for
 * it, or something it asks for imports the app's shell (the demo's file-peek
 * pane imports Files' panes, so Files' shell comes with it). The second kind
 * still owns its URL and its panes, but offering it in a launcher would lead
 * the user to an app the composition never meant to show.
 *
 * The ONE answer both `composition-closure` and registry codegen compute, like
 * {@link resolveCompositionHome}. Pure: the caller reads the declared apps and
 * resolves the bundle.
 */
export type CompositionUnlisted =
  { kind: "ok"; appIds: string[] } | { kind: "error"; message: string };

export function resolveCompositionUnlisted(opts: {
  /** Every declared app, by app id → the plugin (dot id) whose core declares it. */
  apps: ReadonlyMap<string, { plugin: string }>;
  /** The composition's resolved hard closure (dot-form plugin ids). */
  bundle: ReadonlySet<string>;
  /** The manifest's `unlisted` app ids. */
  unlisted: readonly string[];
  /** The manifest's `home` (`""` = none): never unlisted, it is what `/` opens. */
  home: string;
}): CompositionUnlisted {
  const { apps, bundle, unlisted, home } = opts;
  for (const id of unlisted) {
    const app = apps.get(id);
    if (!app) {
      return {
        kind: "error",
        message: `\`unlisted\` names "${id}", which is no app (no \`defineApp({ id: "${id}" })\`).`,
      };
    }
    if (!bundle.has(app.plugin)) {
      return {
        kind: "error",
        message: `\`unlisted\` names "${id}", whose shell ${app.plugin} is not in the bundle — there is nothing to unlist; drop it.`,
      };
    }
    if (id === home) {
      return {
        kind: "error",
        message: `\`unlisted\` names "${id}", the composition's \`home\` — the app \`/\` opens cannot be hidden from its launchers.`,
      };
    }
  }
  if (new Set(unlisted).size !== unlisted.length) {
    return {
      kind: "error",
      message: `\`unlisted\` names an app twice (${unlisted.join(", ")}).`,
    };
  }
  return { kind: "ok", appIds: [...unlisted].sort() };
}
