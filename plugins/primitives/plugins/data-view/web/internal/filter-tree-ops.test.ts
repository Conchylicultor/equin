import { describe, expect, it } from "bun:test";
import type { FilterGroup, FilterRule } from "../../core";
import {
  addGroup,
  addRule,
  deleteNode,
  emptyGroup,
  newRule,
  pruneRules,
  setConjunction,
  updateRule,
  wrapRuleInGroup,
} from "./filter-tree-ops";

function root(...children: FilterGroup["children"]): FilterGroup {
  return { kind: "group", id: "root", conjunction: "and", children };
}

describe("filter-tree-ops", () => {
  it("emptyGroup / newRule mint unique ids and the right shape", () => {
    const g = emptyGroup("or");
    expect(g.kind).toBe("group");
    expect(g.conjunction).toBe("or");
    expect(g.children).toEqual([]);
    const r = newRule("f", "contains");
    expect(r).toMatchObject({ kind: "rule", fieldId: "f", operatorId: "contains" });
    expect(r.id).not.toBe(g.id);
  });

  it("addRule appends a rule to the named group", () => {
    const next = addRule(root(), "root", "title", "contains");
    expect(next.children).toHaveLength(1);
    expect(next.children[0]).toMatchObject({
      kind: "rule",
      fieldId: "title",
      operatorId: "contains",
    });
  });

  it("addGroup appends a nested empty group", () => {
    const next = addGroup(root(), "root", "or");
    expect(next.children).toHaveLength(1);
    expect(next.children[0]).toMatchObject({ kind: "group", conjunction: "or" });
  });

  it("addRule targets a nested group by id", () => {
    const nested = emptyGroup("and");
    const tree = root(nested);
    const next = addRule(tree, nested.id, "x", "is");
    const child = next.children[0] as FilterGroup;
    expect(child.children).toHaveLength(1);
    expect((child.children[0] as FilterRule).fieldId).toBe("x");
  });

  it("updateRule patches a rule in place (and leaves siblings)", () => {
    const r1 = newRule("a", "contains");
    const r2 = newRule("b", "is");
    const tree = root(r1, r2);
    const next = updateRule(tree, r1.id, {
      fieldId: "c",
      operatorId: "is-not",
      value: "hi",
    });
    expect(next.children[0]).toMatchObject({
      fieldId: "c",
      operatorId: "is-not",
      value: "hi",
    });
    // sibling untouched (structural sharing)
    expect(next.children[1]).toBe(r2);
  });

  it("setConjunction sets the whole group's conjunction", () => {
    const next = setConjunction(root(newRule("a", "is")), "root", "or");
    expect(next.conjunction).toBe("or");
  });

  it("setConjunction reaches nested groups", () => {
    const nested = emptyGroup("and");
    const next = setConjunction(root(nested), nested.id, "or");
    expect((next.children[0] as FilterGroup).conjunction).toBe("or");
  });

  it("deleteNode removes a node anywhere", () => {
    const r1 = newRule("a", "is");
    const nested = emptyGroup("and");
    const tree = root(r1, nested);
    const afterRule = deleteNode(tree, r1.id);
    expect(afterRule.children).toHaveLength(1);
    expect(afterRule.children[0]).toBe(nested);
    const afterGroup = deleteNode(tree, nested.id);
    expect(afterGroup.children).toHaveLength(1);
    expect(afterGroup.children[0]).toBe(r1);
  });

  it("deleteNode removes a rule nested inside a group", () => {
    const inner = newRule("a", "is");
    const nested: FilterGroup = {
      kind: "group",
      id: "g",
      conjunction: "and",
      children: [inner],
    };
    const next = deleteNode(root(nested), inner.id);
    expect((next.children[0] as FilterGroup).children).toHaveLength(0);
  });

  it("wrapRuleInGroup wraps a rule in a fresh group in place", () => {
    const r1 = newRule("a", "is");
    const sibling = newRule("b", "is");
    const next = wrapRuleInGroup(root(r1, sibling), r1.id, "or");
    const wrapped = next.children[0] as FilterGroup;
    expect(wrapped.kind).toBe("group");
    expect(wrapped.conjunction).toBe("or");
    expect(wrapped.children).toHaveLength(1);
    expect((wrapped.children[0] as FilterRule).fieldId).toBe("a");
    // sibling preserved
    expect(next.children[1]).toBe(sibling);
  });

  it("edits do not mutate the input tree", () => {
    const rule = newRule("a", "is");
    const tree = root(rule);
    const snapshot = JSON.parse(JSON.stringify(tree));
    addRule(tree, "root", "b", "is");
    setConjunction(tree, "root", "or");
    deleteNode(tree, rule.id);
    expect(tree).toEqual(snapshot);
  });
});

describe("pruneRules", () => {
  it("removes the named rules at any depth, keeping the rest", () => {
    const keep = newRule("a", "is");
    const gone = newRule("b", "is");
    const deep = newRule("c", "is");
    const nested: FilterGroup = {
      kind: "group",
      id: "inner",
      conjunction: "or",
      children: [deep],
    };
    const next = pruneRules(root(keep, gone, nested), [gone.id, deep.id]);
    expect(next).toEqual(root(keep, { ...nested, children: [] }));
  });

  it("is null once no rule is left — the view stores no filter", () => {
    const only = newRule("a", "is");
    const nested: FilterGroup = {
      kind: "group",
      id: "inner",
      conjunction: "or",
      children: [newRule("b", "is")],
    };
    const tree = root(only, nested);
    const ids = [only.id, (nested.children[0] as FilterRule).id];
    expect(pruneRules(tree, ids)).toBeNull();
  });
});
