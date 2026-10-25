/**
 * Converge's refusals — the ones that read the composition's plugin closure, and
 * the one that reads a hostname about to be written into a Caddyfile.
 *
 * They live beside the command rather than inside `./equin check` for the
 * reason `assertClosureSafe` states: hostnames are runtime data a repo check
 * cannot see, and the guard should fire when the exposure is actually created.
 */
import { join } from "node:path";
import {
  REPO_ROOT,
  checkoutNamespace,
} from "@plugins/infra/plugins/paths/server";
import { configDir } from "@plugins/config_v2/data-dirs";
import {
  classifyEdges,
  expandEntrySeeds,
  flattenManifest,
  resolveComposition,
} from "@plugins/plugin-meta/plugins/closure/core";
import type {
  CompositionManifest,
  EdgeGraph,
} from "@plugins/plugin-meta/plugins/closure/core";
import { buildPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  compositionsConfig,
  manifestItemToManifest,
  type CompositionManifestItem,
} from "@plugins/plugin-meta/plugins/composition/core";
import { readEffectiveConfigFromDisk } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { refuse, type DeployTarget } from "./target";

/**
 * The composition names whose bundles carry the OWNER's own data. A deployment
 * with a public hostname may not converge if the composition's closure reaches
 * any of them: converge is the moment a composition becomes internet-reachable,
 * and `agent-manager` on the open internet is conversations, tasks and secrets
 * with no auth in front. Ordinary compositions in the `compositions` config, so
 * what counts as owner data stays editable data rather than a list in code.
 */
const OWNER_DATA_BUNDLES = [
  "agent-runtime",
  "auth",
  "conversations",
  "tasks-domain",
];

/**
 * The secrets STORE is hosted on the CENTRAL runtime, which a released bundle
 * does not have — so a composition whose closure reaches `infra/secrets` is
 * broken in a way the `env` file cannot fix, and converge refuses it. A
 * composition that needs a credential declares a deploy secret instead
 * (`defineDeploySecret`, `apps/deploy/deploy-secrets`): the user approves its
 * value per deployment, converge delivers it into `env` over the SSH session's
 * stdin, and the box reads it with `readDeploySecret`. See the plan,
 * §What goes in `env`.
 */
const SECRETS_PLUGIN_ID = asPluginId("infra.secrets");

/** The `compositions` config's owning plugin — where its jsonc files live. */
const COMPOSITIONS_HIERARCHY_PATH = asPath(
  asPluginId("plugin-meta.composition"),
);

// ── Composition closure (converge's guards) ───────────────────────────────────

interface ClosureContext {
  graph: EdgeGraph;
  manifests: CompositionManifest[];
  items: CompositionManifestItem[];
}

/** Build the plugin tree + edge graph once, and read the live manifest set. */
async function loadClosureContext(): Promise<ClosureContext> {
  const values = readEffectiveConfigFromDisk(compositionsConfig, {
    root: REPO_ROOT,
    // The CHECKOUT's namespace, minted from git. A CLI process has no runtime
    // namespace; reading one used to answer the main namespace from every worktree,
    // so a converge launched from a worktree read MAIN's compositions config.
    userConfigDir: configDir.file(await checkoutNamespace(REPO_ROOT)),
    hierarchyPath: COMPOSITIONS_HIERARCHY_PATH,
  });
  const tree = await buildPluginTree(join(REPO_ROOT, "plugins"), {
    skipBarrelImport: true,
    facets: true,
  });
  return {
    graph: classifyEdges(tree),
    manifests: values.manifests.map(manifestItemToManifest),
    items: values.manifests,
  };
}

/**
 * A bundle's CONTAINMENT: the territory it declares (flattened entries, plus
 * each selected contributor and its subtree), NOT its hard deps. Same rule the
 * `composition-closure` check's `excludes` gate uses, so "carries owner data"
 * means the same thing at converge as it does at check time — using containment
 * keeps generic shared infra usable while the deep taproots listed as a
 * bundle's entries still catch transitive contamination.
 */
function containmentOf(
  target: CompositionManifest,
  ctx: ClosureContext,
): Set<PluginId> {
  const flat = flattenManifest(target, ctx.manifests);
  const containment = new Set<PluginId>(
    expandEntrySeeds(flat, ctx.graph).seeds,
  );
  for (const id of flat.selectedContributors) {
    containment.add(id);
    for (const descendant of ctx.graph.subtree.get(id) ?? [])
      containment.add(descendant);
  }
  return containment;
}

/**
 * The two closure refusals, evaluated BEFORE anything on the host is touched.
 *
 * Both read the composition's resolved hard closure, which is why they live
 * here rather than in `./equin check`: hostnames are runtime data a repo
 * check cannot see, and the guard should fire when the exposure is actually
 * created rather than when unrelated code is compiled.
 */
export async function assertClosureSafe(target: DeployTarget): Promise<void> {
  const composition = target.install.compositionId;
  const ctx = await loadClosureContext();
  const item = ctx.items.find((m) => m.name === composition);
  if (!item) {
    refuse(
      `"${composition}" is not a composition. Known: ${ctx.items
        .map((m) => m.name)
        .sort()
        .join(", ")}`,
    );
  }

  const flat = flattenManifest(manifestItemToManifest(item), ctx.manifests);
  const bundle = resolveComposition(ctx.graph, flat).bundle;
  console.log(`  • closure: ${bundle.size} plugins`);

  // 1. Secrets. Unconditional — a bundle with no central runtime cannot read a
  //    secret at all, so this is broken regardless of who can reach it.
  if (bundle.has(SECRETS_PLUGIN_ID)) {
    refuse(
      `composition "${composition}" needs ${SECRETS_PLUGIN_ID}, which a deployed install cannot have.\n` +
        `The secrets store is hosted on the CENTRAL runtime, which a released bundle does not ` +
        `have — so this composition cannot work as a deployed install. A plugin that needs a ` +
        `credential on the box declares a deploy secret (defineDeploySecret) instead, approved per ` +
        `deployment and delivered into its env file. See ` +
        `research/2026-07-29-global-composition-production-deployment.md, §What goes in \`env\`.`,
    );
  }

  // 2. Public exposure. `exposure` is DERIVED, never declared: a deployment
  //    with a hostname behind an open 443 simply IS public, so there is no flag
  //    to typo.
  if (target.deployment.hostnames.length === 0) return;

  for (const name of OWNER_DATA_BUNDLES) {
    const owner = ctx.manifests.find((m) => m.name === name);
    if (!owner) {
      // Fail loud rather than pass a guard we could not evaluate.
      refuse(
        `cannot evaluate the public-exposure guard: composition "${name}" is not defined in ` +
          `the \`compositions\` config, so the owner-data territory it names cannot be resolved.`,
      );
    }
    const containment = containmentOf(owner, ctx);
    const offenders = [...bundle].filter((id) => containment.has(id)).sort();
    if (offenders.length > 0) {
      refuse(
        `refusing to expose composition "${composition}" on ${target.deployment.hostnames.join(
          ", ",
        )}: its closure includes ${offenders.length} plugin(s) from the "${name}" bundle, ` +
          `which carries the owner's own data (${offenders.slice(0, 8).join(", ")}${
            offenders.length > 8 ? ", …" : ""
          }).\n` +
          `Converge is the moment a composition becomes internet-reachable, and there is no auth ` +
          `in front of it. Remove the hostnames to serve it on loopback only, or deploy a ` +
          `composition that does not bundle owner data.`,
      );
    }
  }
}

// ── D3: the converge script ───────────────────────────────────────────────────
//
// The script itself is `internal/converge-script.ts` — a pure function of plain
// values, so its shell can be syntax-checked and its file-installer exercised by
// `converge-script.test.ts` instead of only by a remote host. What stays here is
// the guard that runs before it.

/**
 * A hostname is about to be written into a Caddyfile, so it is asserted at the
 * injection site as well as at the door.
 *
 * The authority on hostname SHAPE is the create/update endpoint's
 * `HostnameSchema` (a real DNS-label regex); this is the narrower assertion
 * that a value cannot escape a Caddyfile token — deliberately not a second copy
 * of that spec, which would be a second place to keep it right.
 */
export function assertCaddySafeHostname(hostname: string): void {
  if (!/^[a-z0-9.*-]{1,253}$/.test(hostname)) {
    refuse(
      `deployment hostname "${hostname}" is not a plain DNS hostname and will not be written ` +
        `into a Caddy site block. Fix it in the Deploy app.`,
    );
  }
}
