import {
  spendPartToken,
  spendTokenFill,
} from "@plugins/ui/plugins/tokens/plugins/spend-palette/core";
import { SPEND_ROOT_ID, type SpendNode } from "../../core";

const DOLLARS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Whole dollars from $10, cents below (where they still say something). */
export function money(usd: number): string {
  return (usd === 0 || usd >= 10 ? DOLLARS : CENTS).format(usd);
}

/** A share: "34%", "<1%" for a sliver that is not nothing. */
export function pct(share: number): string {
  if (share > 0 && share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/** `part`'s share of `whole` (0 when the whole is nothing). */
export function shareOf(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/**
 * The colour of a level's `index`-th part: the five spend colours in order,
 * the folded rest its neutral.
 */
export function partColor(node: SpendNode, index: number): string {
  return node.kind === "rest"
    ? spendTokenFill("spend-rest")
    : spendTokenFill(spendPartToken(index));
}

/** Whether a node opens into a level of its own. */
export function drills(node: SpendNode): boolean {
  return node.children.length > 0;
}

/** The drill path (node ids, the root's first) as its route param. */
export function pathParam(path: readonly string[]): string {
  return path.join("/");
}

/** The route param as a drill path — the root alone when it names none. */
export function pathOf(param: string): string[] {
  const ids = param.split("/").filter((s) => s !== "");
  return ids[0] === SPEND_ROOT_ID ? ids : [SPEND_ROOT_ID, ...ids];
}

/**
 * The nodes along `path` from the root, as far as they exist — a level that
 * left the tree (its spend fell out of the window) ends the walk there.
 */
export function nodesAlong(
  root: SpendNode,
  path: readonly string[],
): SpendNode[] {
  const out: SpendNode[] = [root];
  for (const id of path.slice(1)) {
    const last = out[out.length - 1];
    const next = last?.children.find((c) => c.id === id);
    if (!next || !drills(next)) break;
    out.push(next);
  }
  return out;
}

/** Where `id` sits in `parent`'s bar: its start and width, as fractions. */
export function segmentOf(
  parent: SpendNode,
  id: string,
): { x: number; w: number } {
  const total = parent.costUsd;
  let acc = 0;
  for (const c of parent.children) {
    if (c.id === id)
      return total > 0
        ? { x: acc / total, w: c.costUsd / total }
        : { x: 0, w: 1 };
    acc += c.costUsd;
  }
  return { x: 0, w: 1 };
}
