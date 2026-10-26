import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { existsSync } from "fs";
import { join } from "path";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  buildEnrichedTree,
  declareSlotsFromBarrels,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import {
  importBarrel,
  registerBarrelStubs,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  inputKeyed?: boolean;
  run(): Promise<CheckResult>;
};

// A CHECK, not a lint rule, on purpose: a contributed lint rule runs repo-wide
// (the root eslint config enables every `plugins/*/lint/` rule as an error over
// `**/*.{ts,tsx}`), and there are many legitimate hand-written `<code>` elements
// elsewhere in the repo. The invariant is path-scoped — inside active-data, an
// inline code span must be the one shared `<InlineCode>` — so it needs a check,
// which can be scoped.
// This file names the banned token in its own pattern, comments and hint — all
// three are masked by `grepCode` (comments, strings AND regex literals), so it is
// self-exempt by construction and needs no allowlist entry.
const SCOPE = "plugins/active-data/";

const check: Check = {
  id: "active-data:no-adhoc-inline-code",
  // INPUT-KEYED (Stage 1). Pure `grepCode` — see no-raw-event-source for rationale.
  inputKeyed: true,
  description:
    "active-data renders inline code through the shared <InlineCode> primitive, never a hand-rolled <code> element",
  async run() {
    const root = await getWorktreeRoot();
    const matches = await grepCode({
      root,
      pattern: /<code[\s/>]/,
      grepArg: "<code",
      fixed: true,
      maskStrings: true,
    });

    const offenders = matches
      .filter((m) => m.path.startsWith(SCOPE))
      .map((m) => `${m.path}:${m.line}:${m.text}`);

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message: `hand-rolled \`<code>\` inside active-data in ${offenders.length} place(s):\n    ${offenders.join("\n    ")}`,
      hint: "Use `<InlineCode>` from `@plugins/primitives/plugins/markdown/web`. A local `<code>` re-states the markdown base styling (so it drifts), and — inside a `display:\"code\"` contribution — it is how a contribution used to publish 'I can't resolve this' as a rendering indistinguishable from success. Declining is `declined(reason)` from `@plugins/active-data/web`; the host owns the fallback.",
    };
  },
};

/**
 * A chip that says it belongs in a document must have a server half.
 *
 * ## What breaks without it
 *
 * `inlineChip({ surfaces: [… "document"] })` is a promise about PAGES: the chip
 * appears in a page block, which means a page block's content doc can now hold
 * that chip's decorator node. On the server, `readStateRuns`
 * (`block-text-write/server/internal/block-doc-text.ts`) REFUSES any block whose
 * doc holds a decorator type it has no registered node for — so the block stops
 * being agent-readable and agent-editable. The chip renders perfectly; the
 * failure surfaces later and somewhere else, as an agent's `edit_page` /
 * `write_agent_note` throwing on a block that looks fine in the browser.
 *
 * The server half is ~8 lines (`Editor.InlineToken({ pattern, markdownSpan, agentCodeSpan, node })`) and
 * nothing in the type system asks for it, because the two halves are two
 * plugins' two barrels. So it is asked for here instead — at check time, on the
 * build that ships the chip, rather than at an agent's first edit.
 *
 * ## Generic by construction
 *
 * Nothing below names a chip. The web side is every contribution to the
 * `InlineChip.Tag` slot (which only `inlineChip` can mint) that declared
 * `"document"`; the server side is every `Editor.InlineToken` contribution's
 * pattern. A fifth chip is covered the day it declares the surface, and a chip
 * that drops `"document"` drops out of the set — no list to update.
 *
 * The join key is the PATTERN SOURCE, which is exact rather than approximate:
 * both halves import the same `RegExp` constant from the family's own `core/`
 * (that is the whole point of `pattern.ts` living there), so the sources are
 * identical whenever the two halves really are two halves of one family. A
 * server contribution that protects DIFFERENT bytes than the chip matches is
 * not the missing half, and is correctly reported as missing.
 */

// Canonical slot tokens. The web one is a declaration-pass id (`<plugin id>` +
// `<key>`, see slot-declaration/core `slotIdFor`) resolved to the slot OBJECT so
// the loop below compares by identity; the server one is the literal registry
// token `defineServerContribution` was given in page/editor's block-registry.
//
// The chip slot is declared by `primitives/text-editor/plugins/inline-chip`, not
// by active-data: the check stays here because the chips that owe a server half
// are active-data's sub-plugins, and the hint below is written for them.
const TAG_SLOT = "primitives.text-editor.inline-chip.tag"; // InlineChip.Tag
const SERVER_INLINE_TOKEN_SLOT = "page.inline-token"; // Editor.InlineToken
const DOCUMENT_SURFACE = "document";

const SERVER_REFERENT_SLOT = "primitives.text-editor.inline-chip.referent"; // InlineTokenReferentSource

/** One declared inline chip, read off its web barrel. */
interface ScannedChip {
  pluginId: string;
  id: string;
  patternSource: string;
  surfaces: readonly unknown[];
  modelText: unknown;
}

type ChipScan =
  | { ok: false; message: string }
  | {
      ok: true;
      chips: ScannedChip[];
      /** Server registry slot id → the pattern sources its contributions label. */
      serverPatterns: Map<string, Set<string>>;
    };

/**
 * Every inline chip (web) and every server contribution's doc label (both
 * `Editor.InlineToken` and `InlineTokenReferentSource` label with their
 * pattern's source), from ONE walk of the barrel-imported tree — the scan both
 * chip checks below join over. A scan that recognises nothing is a failure,
 * never a clean pass.
 */
async function scanInlineChips(): Promise<ChipScan> {
  const root = await getWorktreeRoot();
  // The barrel-imported ("enriched") tree — the same one docgen renders the
  // contribution lines from. Its contributions facet carries BOTH halves:
  // web slot contributions and server registry contributions.
  const tree = await buildEnrichedTree(root);
  registerBarrelStubs(root);

  const naming = await declareSlotsFromBarrels(root, "registry");
  const tagSlot: SlotHandle | undefined = naming.findSlot(TAG_SLOT);
  if (tagSlot === undefined) {
    return {
      ok: false,
      message:
        `No slot is declared under "${TAG_SLOT}" in the registry-scoped declaration pass, so no ` +
        "chip contribution could be recognized and nothing was verified. A slot id derives from " +
        "its declaring plugin's id plus its `slots` key, so moving or renaming the inline-chip " +
        "plugin renames it. This is a check/tooling failure, not a clean pass.",
    };
  }

  // Which plugins contribute a chip at all, and which patterns each server
  // registry already covers — one walk of the same tree.
  const candidateDirs = new Set<string>();
  const serverPatterns = new Map<string, Set<string>>();
  for (const [dir, node] of tree.byDir) {
    const facet = getFacet(node, contributionsFacetDef);
    if (!facet) continue;
    for (const c of facet.runtime) {
      if (c.kind === "slot" && c.slotId === TAG_SLOT) {
        // A web slot contribution can only have come from a web barrel; the
        // guard is belt-and-braces so a tree oddity cannot turn into a throw.
        if (existsSync(join(dir, "web", "index.ts"))) candidateDirs.add(dir);
      } else if (c.kind === "server" && c.doc.label) {
        let set = serverPatterns.get(c.slotId);
        if (!set) {
          set = new Set();
          serverPatterns.set(c.slotId, set);
        }
        set.add(c.doc.label);
      }
    }
  }

  if (candidateDirs.size === 0) {
    return {
      ok: false,
      message:
        `No \`InlineChip.Tag\` contributions found in the enriched plugin tree — the ` +
        "barrel-imported contributions facet is empty, so no chip invariant could " +
        "be verified. This is a check/tooling failure, not a clean pass.",
    };
  }

  // `surfaces` / `modelText` are not on the doc label, so the chips themselves
  // are read off the barrels — the same import the anchor/tag checks in
  // page/editor do. Barrel modules are Bun-cached, so this costs nothing after
  // the tree build.
  const chips: ScannedChip[] = [];
  for (const dir of candidateDirs) {
    const mod = await importBarrel(join(dir, "web", "index.ts"));
    const def = mod.default as { contributions?: unknown } | undefined;
    if (!Array.isArray(def?.contributions)) continue;
    for (const raw of def.contributions) {
      const c = raw as {
        _slot?: SlotHandle;
        id?: unknown;
        pattern?: unknown;
        surfaces?: unknown;
        modelText?: unknown;
      };
      if (c._slot !== tagSlot) continue;
      chips.push({
        pluginId: tree.byDir.get(dir)?.id ?? dir,
        id: typeof c.id === "string" ? c.id : "<unnamed>",
        patternSource:
          c.pattern instanceof RegExp ? c.pattern.source : "<not a RegExp>",
        surfaces: Array.isArray(c.surfaces) ? c.surfaces : [],
        modelText: c.modelText,
      });
    }
  }

  if (chips.length === 0) {
    return {
      ok: false,
      message:
        `${candidateDirs.size} plugin(s) contribute to \`InlineChip.Tag\`, but no contribution off ` +
        "them was recognized as an inline chip, so nothing was verified. This is a check/tooling " +
        "failure, not a clean pass.",
    };
  }
  return { ok: true, chips, serverPatterns };
}

const documentChipHasServerToken: Check = {
  id: "active-data:document-chip-has-server-token",
  description:
    'every inline chip declaring `surfaces: ["…","document"]` also contributes the server `Editor.InlineToken` half, so a page block holding it stays agent-readable',
  async run() {
    const scan = await scanInlineChips();
    if (!scan.ok) return scan;
    const serverPatterns = scan.serverPatterns.get(SERVER_INLINE_TOKEN_SLOT);
    if (serverPatterns === undefined || serverPatterns.size === 0) {
      return {
        ok: false,
        message:
          `No server \`${SERVER_INLINE_TOKEN_SLOT}\` contributions were observed while scanning the ` +
          "plugin tree. Either the server-side contribution scan silently degraded, or no token " +
          "family registers a server half at all — the page editor renders several, so both " +
          "readings are failures and neither is a clean pass.",
      };
    }
    const documentChips = scan.chips.filter((chip) =>
      chip.surfaces.includes(DOCUMENT_SURFACE),
    );

    const missing = documentChips
      .filter((chip) => !serverPatterns.has(chip.patternSource))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (missing.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `${missing.length} inline chip(s) declare the "document" surface with no server ` +
        `\`Editor.InlineToken\` half, so a page block holding one is refused by \`readStateRuns\` — ` +
        `every agent edit of that block throws:\n` +
        missing
          .map(
            (chip) =>
              `  chip "${chip.id}" (${chip.pluginId}) — pattern /${chip.patternSource}/`,
          )
          .join("\n"),
      hint:
        "Add the server barrel beside the web one:\n" +
        "  // plugins/active-data/plugins/<chip>/server/index.ts\n" +
        '  import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";\n' +
        '  import { Editor } from "@plugins/page/plugins/editor/server";\n' +
        '  import { inlineChipNode } from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/core";\n' +
        '  import { <PATTERN> } from "../core";\n' +
        '  export default { description: "…", contributions: [Editor.InlineToken({ pattern: <PATTERN>, markdownSpan: "transparent", agentCodeSpan: "token", node: inlineChipNode })] } satisfies ServerPluginDefinition;\n' +
        '`markdownSpan: "transparent"` is right for every bare-id chip: the pattern says WHERE the ' +
        "token is, it does NOT ask for the bytes to be masked from the marks-aware inline markdown " +
        "scan — and a bare id must not be, since a masked span becomes its own UNMARKED run and an " +
        "id written inside backticks would lose its `code` mark and chip itself. Only a token " +
        'carrying markdown-hostile characters (`[[page:…]]`, `\(latex\)`) says `"protect"`.\n' +
        "It must name the SAME pattern constant the chip does (that is the join key here, and the " +
        "reason both halves import it from the family's own `core/`). See " +
        "plugins/active-data/plugins/attempt/server/index.ts for the precedent. If the chip does " +
        'not belong in pages after all, drop "document" from its `surfaces` instead — that is the ' +
        "declaration the two out-of-scope chips (`page-link`, `<ui-context>`) make.",
    };
  },
};

/**
 * A chip that says a model reads it `"resolved"` must have a server resolver.
 *
 * `inlineChip({ modelText: "resolved" })` promises that text a MODEL reads (a
 * task description Haiku titles) gets the referent's title rather than the
 * opaque id — which only holds if the family's server half contributes an
 * `InlineTokenReferentSource` over the same pattern. Nothing in the type system
 * joins the web and server barrels, so the join is here. Generic: names no chip.
 */
const resolvedChipHasReferent: Check = {
  id: "active-data:resolved-chip-has-referent",
  description:
    'every inline chip declaring `modelText: "resolved"` also contributes a server `InlineTokenReferentSource` over the same pattern, so a model reads the referent\'s title instead of an opaque id',
  async run() {
    const scan = await scanInlineChips();
    if (!scan.ok) return scan;
    const referentPatterns =
      scan.serverPatterns.get(SERVER_REFERENT_SLOT) ?? new Set<string>();
    const missing = scan.chips
      .filter(
        (chip) =>
          chip.modelText === "resolved" &&
          !referentPatterns.has(chip.patternSource),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${missing.length} inline chip(s) declare \`modelText: "resolved"\` with no server ` +
        "`InlineTokenReferentSource`, so a model reading their token sees only the raw id:\n" +
        missing
          .map(
            (chip) =>
              `  chip "${chip.id}" (${chip.pluginId}) — pattern /${chip.patternSource}/`,
          )
          .join("\n"),
      hint:
        "In the chip family's server barrel, contribute\n" +
        '  InlineTokenReferentSource({ kind: "<tag name>", pattern: <PATTERN>, resolve })\n' +
        "from `@plugins/primitives/plugins/text-editor/plugins/inline-chip/server`, naming the SAME " +
        "pattern constant the chip does (the join key). See " +
        "plugins/active-data/plugins/prototype/server/index.ts. If the raw token already reads " +
        'well to a model, declare `modelText: "self-describing"` on the chip instead.',
    };
  },
};

export default [check, documentChipHasServerToken, resolvedChipHasReferent];
