import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  buildEnrichedTree,
  codegenPassOver,
  type CodegenPass,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import { parseKindLabel } from "../core";
import { pkDeclared } from "./internal/pk-declared";

// The id-kind registry's invariants, read off the docs facet of the
// barrel-imported plugin tree — the same scan docgen renders contribution lines
// from. Every `IdKinds.*` contribution labels itself (a `Kind` with
// `prefix|alias|…`, a `Presenter` / `Referent` with its prefix), so nothing
// here imports a barrel or names a kind: a new kind is covered the day its
// owner registers it.

// Web slot ids derive from the declaring plugin (`ids`) plus the slot key; the
// server registry tokens are the `defineServerContribution` debug names. Both
// spell the same strings, told apart by the facet's `kind`.
const KIND = "ids.kind";
const PRESENTER = "ids.presenter";
const REFERENT = "ids.referent";

type Runtime = "web" | "server";

interface Registration {
  pluginId: string;
  runtime: Runtime;
  label: string;
}

type Scan =
  | { ok: false; message: string }
  | {
      ok: true;
      kinds: Registration[];
      presenters: Registration[];
      referents: Registration[];
    };

async function scan(pass: CodegenPass): Promise<Scan> {
  const tree = await buildEnrichedTree(pass);
  const kinds: Registration[] = [];
  const presenters: Registration[] = [];
  const referents: Registration[] = [];
  for (const [dir, node] of tree.byDir) {
    const facet = getFacet(node, contributionsFacetDef);
    if (!facet) continue;
    for (const c of facet.runtime) {
      const label = c.doc.label;
      if (!label) continue;
      const runtime: Runtime = c.kind === "slot" ? "web" : "server";
      const reg = { pluginId: node.id ?? dir, runtime, label };
      if (c.slotId === KIND) kinds.push(reg);
      else if (c.slotId === PRESENTER && runtime === "web")
        presenters.push(reg);
      else if (c.slotId === REFERENT && runtime === "server")
        referents.push(reg);
    }
  }
  if (kinds.length === 0) {
    return {
      ok: false,
      message:
        `No \`IdKinds.Kind\` contributions found in the enriched plugin tree, so no id-kind ` +
        "invariant could be verified. The repo registers several kinds (task, att, conv, " +
        "proto, block), so this is a check/tooling failure, not a clean pass.",
    };
  }
  return { ok: true, kinds, presenters, referents };
}

function describe(r: Registration): string {
  return `${r.pluginId} (${r.runtime})`;
}

const prefixUnique: Check = {
  id: "ids:prefix-unique",
  description:
    "every id kind's prefix is unique repo-wide, and no kind's alias is another kind's prefix",
  async run(ctx): Promise<CheckResult> {
    const s = await scan(codegenPassOver(await ctx.repo()));
    if (!s.ok) return s;
    const problems: string[] = [];
    for (const runtime of ["web", "server"] as const) {
      const own = s.kinds.filter((k) => k.runtime === runtime);
      const byPrefix = new Map<string, Registration[]>();
      for (const k of own) {
        const { prefix } = parseKindLabel(k.label);
        byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), k]);
      }
      for (const [prefix, regs] of byPrefix) {
        if (regs.length > 1) {
          problems.push(
            `prefix "${prefix}" is declared by ${regs.length} kinds: ${regs.map(describe).join(", ")}`,
          );
        }
      }
      // An alias SHARED by two kinds is legitimate (`claude` named both an
      // attempt and its conversation before the split): aliases are
      // recognition-only by construction — `kind.pattern`, the inline reading,
      // never includes them, so a shared alias is only ever read where the
      // caller already knows the kind. An alias that is another kind's live
      // prefix, though, would make that kind's ids ambiguous even there.
      for (const k of own) {
        for (const alias of parseKindLabel(k.label).aliases) {
          const owner = byPrefix.get(alias);
          if (owner) {
            problems.push(
              `alias "${alias}" of ${describe(k)} is the prefix of ${owner.map(describe).join(", ")}`,
            );
          }
        }
      }
    }
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${problems.length} id-prefix collision(s):\n  ${[...new Set(problems)].join("\n  ")}`,
      hint: "A prefix names exactly one kind: rename one of them (prefixes are `/^[a-z][a-z0-9]{1,9}$/`). See plugins/ids/CLAUDE.md.",
    };
  },
};

const kindBothRuntimes: Check = {
  id: "ids:kind-both-runtimes",
  description:
    "every id kind registered on one runtime's IdKinds.Kind is registered on the other, with the same aliases",
  async run(ctx): Promise<CheckResult> {
    const s = await scan(codegenPassOver(await ctx.repo()));
    if (!s.ok) return s;
    const labels = (runtime: Runtime) =>
      new Map(
        s.kinds
          .filter((k) => k.runtime === runtime)
          .map((k) => [k.label, k] as const),
      );
    const web = labels("web");
    const server = labels("server");
    const missing: string[] = [];
    for (const [label, k] of web) {
      if (!server.has(label))
        missing.push(`"${label}" — web only (${k.pluginId})`);
    }
    for (const [label, k] of server) {
      if (!web.has(label))
        missing.push(`"${label}" — server only (${k.pluginId})`);
    }
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${missing.length} id kind(s) registered on one runtime only:\n  ${missing.sort().join("\n  ")}`,
      hint:
        "Contribute `IdKinds.Kind({ kind })` from BOTH the owning plugin's web barrel " +
        "(`@plugins/ids/web`) and its server barrel (`@plugins/ids/server`), with the kind " +
        "imported from its `core/` — so `useIdKinds()` and `getIdKinds()` agree.",
    };
  },
};

const presenterHasReferent: Check = {
  id: "ids:presenter-has-referent",
  description:
    "every id kind presented in the browser (IdKinds.Presenter) has a server IdKinds.Referent — the join is on the kind's prefix",
  async run(ctx): Promise<CheckResult> {
    const s = await scan(codegenPassOver(await ctx.repo()));
    if (!s.ok) return s;
    const referents = new Set(s.referents.map((r) => r.label));
    const missing = s.presenters.filter((p) => !referents.has(p.label));
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${missing.length} presented id kind(s) with no server referent, so a model reading ` +
        "the id gets no title for it:\n  " +
        missing.map((p) => `"${p.label}" (${p.pluginId})`).join("\n  "),
      hint:
        "Spread `idChipServer({ kind, surfaces, resolve })` (`@plugins/active-data/plugins/id-chip/server`) " +
        "into the presenting family's server barrel — the twin of its web `idChip(...)`.",
    };
  },
};

export default [
  prefixUnique,
  kindBothRuntimes,
  presenterHasReferent,
  pkDeclared,
];
