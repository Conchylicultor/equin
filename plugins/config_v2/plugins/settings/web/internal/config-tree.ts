import { pluginIdSegments } from "@plugins/framework/plugins/plugin-id/core";
import type { ConfigRegistration } from "@plugins/config_v2/web";

/**
 * One node of the config nav's hierarchy: a plugin id prefix that carries a
 * config itself or has a config-bearing plugin below it.
 */
export interface ConfigTreeNode {
  /** The canonical DOT-form plugin id of this node (a prefix of a registration's). */
  id: string;
  /** The id's last segment — the plugin's directory name. */
  name: string;
  /** Configs declared directly by this plugin. Empty for pure group nodes. */
  registrations: ConfigRegistration[];
  /** Children, sorted by name (each contains a registration somewhere below). */
  children: ConfigTreeNode[];
}

/**
 * The config nav's hierarchy, built from the config registrations alone: each
 * registration's `pluginId` segments are its path (`apps.sonata.metronome` sits
 * under `apps` → `sonata`), and every plugin id prefix is itself a plugin, so the
 * result is the plugin tree pruned to its config-bearing branches — the same
 * nodes, names (a node's name is its id's last segment) and sibling order (by
 * name) the plugin tree has — without reading the plugin tree. That tree is a
 * scan of `plugins/` on disk, which only the computer can answer; the
 * registrations are in every browser, so Settings → Config groups the same way
 * on the computer and in a browser host.
 */
export function buildConfigTree(
  registrations: readonly ConfigRegistration[],
): ConfigTreeNode[] {
  const roots: ConfigTreeNode[] = [];
  const byId = new Map<string, ConfigTreeNode>();
  for (const reg of registrations) {
    let siblings = roots;
    let node: ConfigTreeNode | undefined;
    const segments = pluginIdSegments(reg.pluginId);
    for (let i = 0; i < segments.length; i++) {
      const id = segments.slice(0, i + 1).join(".");
      node = byId.get(id);
      if (!node) {
        node = { id, name: segments[i]!, registrations: [], children: [] };
        byId.set(id, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
    node?.registrations.push(reg);
  }
  const sortRec = (list: ConfigTreeNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}
