import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  AREA_BUDGET,
  OWNER_PATTERN,
  parseStorageSize,
  type StorageArea,
} from "../core";

type Declared = { owner: string; area: StorageArea; cap: string; at: string };

/** `<field>: "<literal>"` inside a declaration's text. */
function field(text: string, name: string): string | null {
  return new RegExp(`\\b${name}:\\s*"([^"]*)"`).exec(text)?.[1] ?? null;
}

/**
 * Every `defineStore({...})` in the repo, read statically, so the budget covers
 * owners whose plugin a given page never loads (the runtime assert in
 * `defineStore` sees only the loaded ones). The declaration's owner, area and
 * cap must be string literals for this to read them.
 */
const check: Check = {
  id: "budget-fits",
  description:
    "Every web-storage owner (defineStore) has a unique literal owner id, and each area's caps sum within its budget",
  outOfScope: ["test", "e2e", "research"],
  async run(ctx) {
    const root = await getWorktreeRoot();
    const matches = await grepCode({
      root,
      pattern: /\bdefineStore(<[^>]*>)?\(\{/,
      grepArg: "defineStore",
      fixed: true,
      maskStrings: true,
    });
    const problems: string[] = [];
    const declared: Declared[] = [];
    const sources = new Map<string, string[]>();
    for (const m of matches) {
      if (!ctx.inScope(m.path)) continue;
      let lines = sources.get(m.path);
      if (!lines) {
        lines = (await readFile(join(root, m.path), "utf8")).split("\n");
        sources.set(m.path, lines);
      }
      // The declaration runs to the first line closing the call.
      const body: string[] = [];
      for (let i = m.line - 1; i < lines.length; i++) {
        body.push(lines[i] ?? "");
        if (/^\s*\}\)/.test(lines[i] ?? "") && i >= m.line) break;
      }
      const text = body.join("\n");
      const at = `${m.path}:${m.line}`;
      const owner = field(text, "owner");
      const area = field(text, "area");
      const cap = field(text, "cap");
      if (!owner || !cap || (area !== "local" && area !== "session")) {
        problems.push(`${at}: owner, area and cap must be string literals`);
        continue;
      }
      if (!OWNER_PATTERN.test(owner)) {
        problems.push(`${at}: owner "${owner}" must match ${OWNER_PATTERN}`);
        continue;
      }
      declared.push({ owner, area, cap, at });
    }

    const byOwner = new Map<string, Declared>();
    for (const d of declared) {
      const prev = byOwner.get(d.owner);
      if (prev)
        problems.push(
          `${d.at}: owner "${d.owner}" already declared at ${prev.at}`,
        );
      else byOwner.set(d.owner, d);
    }

    for (const area of ["local", "session"] as const) {
      const owners = declared.filter((d) => d.area === area);
      let total = 0;
      for (const d of owners) {
        try {
          total += parseStorageSize(d.cap);
        } catch (err) {
          problems.push(`${d.at}: ${(err as Error).message}`);
        }
      }
      const budget = parseStorageSize(AREA_BUDGET[area]);
      if (total > budget) {
        const list = owners
          .sort((a, b) => parseStorageSize(b.cap) - parseStorageSize(a.cap))
          .map((d) => `${d.owner} ${d.cap}`)
          .join(", ");
        problems.push(
          `${area} owners' caps sum to ${(total / 1024 / 1024).toFixed(2)} MB, over the ${AREA_BUDGET[area]} budget: ${list}`,
        );
      }
    }

    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: problems.join("\n    "),
      hint: "Lower a cap (or evict-oldest a cache) so each area's owners fit AREA_BUDGET in primitives/dom/web-storage/core — the headroom is what keeps one owner from filling the browser's quota for the others.",
    };
  },
};

export default check;
