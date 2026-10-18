import {
  filterNodeIdKind,
  type FilterConjunction,
  type FilterGroup,
  type FilterNode,
  type FilterRule,
} from "../../core";

/**
 * Pure, immutable edit helpers for the filter tree. Every operation returns a
 * NEW tree (structural sharing for untouched subtrees) keyed by node `id`, so
 * React keys stay stable and the popover builder can drive `setFilter` with a
 * plain functional update. No mutation, no `Math.random`/`Date.now` — ids come
 * from `newNodeId()` (`filterNodeIdKind`, a `fnode-<uuid>`).
 */

/** Mint a fresh local node id (React key / edit handle). */
export function newNodeId(): string {
  return filterNodeIdKind.mint();
}

/** A fresh empty root/child group with the given conjunction. */
export function emptyGroup(
  conjunction: FilterConjunction = "and",
): FilterGroup {
  return { kind: "group", id: newNodeId(), conjunction, children: [] };
}

/** A fresh rule shell (caller supplies field + operator). */
export function newRule(fieldId: string, operatorId: string): FilterRule {
  return { kind: "rule", id: newNodeId(), fieldId, operatorId };
}

/**
 * Replace the node with `id` (anywhere in the tree) by mapping it through
 * `fn`. Returns the same tree reference when nothing matched. Used as the
 * single primitive that every other "edit a specific node" helper builds on.
 */
function mapNode(
  node: FilterNode,
  id: string,
  fn: (node: FilterNode) => FilterNode,
): FilterNode {
  if (node.id === id) return fn(node);
  if (node.kind !== "group") return node;
  let changed = false;
  const children = node.children.map((child) => {
    const next = mapNode(child, id, fn);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/** Replace the root group itself, or any descendant, by id. */
function editTree(
  root: FilterGroup,
  id: string,
  fn: (node: FilterNode) => FilterNode,
): FilterGroup {
  return mapNode(root, id, fn) as FilterGroup;
}

/** Append `child` to the group identified by `groupId`. */
export function addChild(
  root: FilterGroup,
  groupId: string,
  child: FilterNode,
): FilterGroup {
  return editTree(root, groupId, (node) => {
    if (node.kind !== "group") return node;
    return { ...node, children: [...node.children, child] };
  });
}

/** Add a fresh rule to a group. */
export function addRule(
  root: FilterGroup,
  groupId: string,
  fieldId: string,
  operatorId: string,
): FilterGroup {
  return addChild(root, groupId, newRule(fieldId, operatorId));
}

/** Add a fresh empty nested group to a group. */
export function addGroup(
  root: FilterGroup,
  groupId: string,
  conjunction: FilterConjunction = "and",
): FilterGroup {
  return addChild(root, groupId, emptyGroup(conjunction));
}

/** Patch the rule with `ruleId` by merging `patch` onto it. */
export function updateRule(
  root: FilterGroup,
  ruleId: string,
  patch: Partial<Omit<FilterRule, "kind" | "id">>,
): FilterGroup {
  return editTree(root, ruleId, (node) => {
    if (node.kind !== "rule") return node;
    return { ...node, ...patch };
  });
}

/** Set a group's conjunction (and/or). */
export function setConjunction(
  root: FilterGroup,
  groupId: string,
  conjunction: FilterConjunction,
): FilterGroup {
  return editTree(root, groupId, (node) => {
    if (node.kind !== "group") return node;
    return { ...node, conjunction };
  });
}

/**
 * Remove the node with `id` from anywhere in the tree (recursively pruning it
 * from its parent's children). The root group can never be removed by id here —
 * clearing the whole filter is the caller's job (`setFilter(null)`).
 */
export function deleteNode(root: FilterGroup, id: string): FilterGroup {
  function prune(node: FilterNode): FilterNode {
    if (node.kind !== "group") return node;
    let changed = false;
    const children: FilterNode[] = [];
    for (const child of node.children) {
      if (child.id === id) {
        changed = true;
        continue;
      }
      const pruned = prune(child);
      if (pruned !== child) changed = true;
      children.push(pruned);
    }
    return changed ? { ...node, children } : node;
  }
  return prune(root) as FilterGroup;
}

/**
 * `root` without the rules `ids` names (`deleteNode` for each), or `null` when
 * no rule is left — a tree of empty groups constrains nothing, and the view
 * stores no filter rather than one that says nothing.
 */
export function pruneRules(
  root: FilterGroup,
  ids: readonly string[],
): FilterGroup | null {
  const pruned = ids.reduce((tree, id) => deleteNode(tree, id), root);
  return countRules(pruned) === 0 ? null : pruned;
}

/**
 * Wrap the rule with `ruleId` in a fresh group (default conjunction "and"),
 * replacing the rule in place with the new group containing it. Notion's "Turn
 * into group" affordance.
 */
export function wrapRuleInGroup(
  root: FilterGroup,
  ruleId: string,
  conjunction: FilterConjunction = "and",
): FilterGroup {
  return editTree(root, ruleId, (node) => {
    if (node.kind !== "rule") return node;
    return {
      kind: "group",
      id: newNodeId(),
      conjunction,
      children: [node],
    };
  });
}

/**
 * Find the group with `id` anywhere in the tree, or `undefined`. The panel reads
 * a nested group by ID rather than holding onto the object: a pushed sub-panel
 * outlives several edits to the tree it is showing, and a captured node would be
 * the one from the moment it was opened.
 */
export function findGroup(
  root: FilterGroup,
  id: string,
): FilterGroup | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    if (child.kind !== "group") continue;
    const found = findGroup(child, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * How many rules a node holds, at any depth — what a collapsed group row counts
 * when it says "Group · 3 conditions". Every rule counts, complete or not: the
 * row is describing what is IN the group, not what is currently filtering.
 */
export function countRules(node: FilterNode): number {
  if (node.kind !== "group") return 1;
  return node.children.reduce((sum, child) => sum + countRules(child), 0);
}
