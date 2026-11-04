import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { dirname, join } from "path";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  findImports,
  findMarkerCalls,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";

/**
 * A token family's IDENTITY belongs to the plugins that declare it — the one
 * that owns the shape and the one that registers it as a token. No consumer
 * outside them may name it.
 *
 * ## The defect this exists for
 *
 * `read-only-view/runs-renderer.tsx` used to import `PAGE_LINK_TOKEN_PATTERN`
 * and `INLINE_MATH_TOKEN_PATTERN` and race the two hardcoded regexes against
 * each line. Nothing was wrong with the code it named — the problem was that it
 * named anything at all: the closed set it hardcoded had exactly two members,
 * and when `inline-date` shipped a third nobody edited the renderer. So
 * `[[date:…]]` rendered as literal brackets on every read-only surface (page
 * history, diffs, agent notes) for as long as it took someone to notice. The
 * renderer is registry-driven now; this is what keeps it that way, and keeps
 * the next consumer from re-opening the same hole somewhere else.
 *
 * ## Why a CHECK and not a lint rule
 *
 * A contributed lint rule runs REPO-WIDE (the root eslint config enables every
 * `plugins/*​/lint/` rule as an error over `**​/*.{ts,tsx}`), and "may this file
 * name that identifier?" is a question about the RELATIONSHIP between two
 * paths — the referencing file and the declaring plugin's subtree. An
 * ESLint rule sees one file at a time and would have to hardcode the owners to
 * answer it, which is the very thing being banned. Same reasoning as
 * `active-data/check/index.ts`'s scoped check, one level up: that one is
 * path-scoped, this one is path-RELATIVE.
 *
 * ## What counts as a token identity, and how the set is discovered
 *
 * Nothing is hardcoded — a fifth token family is governed the day it registers,
 * with no edit here:
 *
 * - a **node spec**: `export const X = defineInlineTokenNode(…)`.
 * - a **token pattern**: a SCREAMING_CASE identifier passed as `pattern:` to one
 *   of the three registrars (`inlineChip`, `tokenExtension`,
 *   `Editor.InlineToken`). Being registered as a token's pattern is what makes
 *   an identifier a token identity — which is exactly why a plugin may still
 *   compose a pattern out of an id shape somebody else owns (`PROTOTYPE_ID_RE`
 *   from the prototypes domain): a shape nobody registers as a token is not a
 *   token identity, and deriving a pattern from the mint's own shape is the good
 *   pattern, not the banned one.
 *
 * ## Who owns one
 *
 * A family's identity is held JOINTLY by the plugin that declares the shape
 * (`export const X`) and every plugin that registers it as a token. Both are
 * acts of declaring the family; what is banned is a THIRD party — a consumer —
 * naming it. So `ui-context/element-picker` may name `UI_CONTEXT_RE`, which the
 * `ui-context` primitive declares and the picker turns into a chip, while a
 * renderer that merely wants to draw the result may not name either.
 *
 * Ownership is by SUBTREE: a plugin directory is the nearest ancestor with a
 * `package.json`, and everything under it is inside. The shared
 * `inlineChipNode` shows both rules at once: `text-editor/inline-chip` declares
 * it, and each of active-data's four chip sub-plugins REGISTERS it (as their
 * server `Editor.InlineToken` node), which is what lets them name it.
 *
 * Only IMPORTS count as naming it. A local `const corpusTokenNode = …` in
 * someone else's test is a different binding that happens to share a name, not
 * a reach into another plugin's identity.
 *
 * The `page.editor` server registry is not exempted and needs no exemption: it
 * reads `Editor.InlineToken.getContributions()` generically and names no
 * family. If it ever has to name one, that is the defect, not the check.
 */

/** The three calls a token pattern is registered through. */
const REGISTRARS = ["inlineChip", "tokenExtension", "InlineToken"] as const;

/** `export const <name> = defineInlineTokenNode…` — the node-spec declaration. */
const NODE_SPEC_DECL =
  /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*defineInlineTokenNode\b/g;

/**
 * `pattern: <SCREAMING_CASE>` inside a registrar call's arguments.
 *
 * SCREAMING_CASE by convention, and deliberately: it keeps a shorthand
 * (`{ id, pattern, node }`) and a member expression (`opts.pattern`) — neither
 * of which names an exported identity — out of the set without a parser.
 */
const PATTERN_ARG = /\bpattern\s*:\s*([A-Z][A-Z0-9_]*)\b/g;

/**
 * `node: <identifier>` inside a registrar call's arguments — the same reading
 * for the node half, with no case convention (a node spec is camelCase). Only
 * names that turn out to BE declared node specs are kept, so a stray `node:`
 * elsewhere contributes nothing.
 */
const NODE_ARG = /\bnode\s*:\s*([A-Za-z_$][\w$]*)\b/g;

const PATHSPECS = ["plugins/**/*.ts", "plugins/**/*.tsx"];

/**
 * The plugin directory owning `rel`: the nearest ancestor with a `package.json`.
 *
 * Read off the filesystem rather than from a runtime-folder name list, because
 * "a directory with a package.json" IS this repo's definition of a plugin — a
 * name list would have to be kept in sync with one, and a `check/` or `e2e/`
 * folder missing from it would silently widen ownership to the parent.
 */
function pluginRootOf(root: string, rel: string): string | null {
  let dir = dirname(rel);
  while (dir && dir !== "." && dir !== "/") {
    if (existsSync(join(root, dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return null;
}

/** Every capture of `re` over `text`, with `re`'s `lastIndex` left alone. */
function captures(re: RegExp, text: string): string[] {
  const scan = new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : re.flags + "g",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = scan.exec(text))) out.push(m[1]!);
  return out;
}

const noTokenIdentityOutsideOwner: Check = {
  id: "page.editor:no-token-identity-outside-owner",
  description:
    "only a token family's own plugin subtree may name its identity (its `pattern:` constant or its `defineInlineTokenNode` spec) — every other surface reads the registry",
  async run(): Promise<CheckResult> {
    const root = await getWorktreeRoot();

    // Pass 1 — the registrations. Every node spec is declared at its own
    // registration site, so this pass yields those declarations directly; a
    // token pattern is only NAMED here (it is declared elsewhere), so this pass
    // collects the names and pass 2 finds where they come from. Either way the
    // registering plugin is recorded as a co-owner.
    const registrations = await listCandidateSources({
      root,
      grepArg: "defineInlineTokenNode|inlineChip|tokenExtension|InlineToken",
      pathspecs: PATHSPECS,
    });

    // identity name -> the plugin dir that DECLARES it.
    const declaredIn = new Map<string, string>();
    // identity name -> the plugin dirs that REGISTER it as a token.
    const registeredIn = new Map<string, Set<string>>();
    const patternNames = new Set<string>();
    let nodeSpecCount = 0;

    for (const { rel, src } of registrations) {
      const owner = pluginRootOf(root, rel);
      if (!owner) continue;
      const masked = maskSource(src);
      for (const name of captures(NODE_SPEC_DECL, masked)) {
        declaredIn.set(name, owner);
        nodeSpecCount++;
      }
      for (const marker of REGISTRARS) {
        for (const call of findMarkerCalls(src, marker)) {
          // The args are sliced from the ORIGINAL source, so a comment inside
          // them could otherwise contribute a phantom name.
          const args = maskSource(call.argsText);
          const named = [
            ...captures(PATTERN_ARG, args),
            ...captures(NODE_ARG, args),
          ];
          for (const name of captures(PATTERN_ARG, args))
            patternNames.add(name);
          for (const name of named) {
            const dirs = registeredIn.get(name) ?? new Set<string>();
            dirs.add(owner);
            registeredIn.set(name, dirs);
          }
        }
      }
    }

    // Pass 2 — where each registered pattern is declared.
    if (patternNames.size > 0) {
      const declarations = await listCandidateSources({
        root,
        grepArg: [...patternNames].join("|"),
        pathspecs: PATHSPECS,
      });
      for (const { rel, src } of declarations) {
        const masked = maskSource(src);
        for (const name of patternNames) {
          if (declaredIn.has(name)) continue;
          if (!new RegExp(`\\bexport\\s+const\\s+${name}\\b`).test(masked)) {
            continue;
          }
          const owner = pluginRootOf(root, rel);
          if (owner) declaredIn.set(name, owner);
        }
      }
    }

    // A check that verified nothing must fail loudly rather than pass
    // vacuously. Both halves are canaries for a DIFFERENT degradation: no node
    // specs means the declaration scan broke, no patterns means the registrar
    // marker scan did. Neither can legitimately be empty while the page editor
    // renders a single inline token.
    if (nodeSpecCount === 0 || patternNames.size === 0) {
      return {
        ok: false,
        message:
          `The token-identity scan found ${nodeSpecCount} node spec(s) and ` +
          `${patternNames.size} registered pattern(s) — at least one side is empty, so ownership ` +
          "was NOT verified. Either the registrars were renamed (`defineInlineTokenNode` / " +
          `${REGISTRARS.map((r) => `\`${r}\``).join(" / ")}) or the scan silently degraded. ` +
          "This is a check/tooling failure, not a clean pass.",
      };
    }

    // The governed set: every identity, with the plugin subtrees allowed to
    // name it (its declaring plugin, plus every plugin registering it).
    const owners = new Map<string, Set<string>>();
    for (const [name, declaring] of declaredIn) {
      owners.set(name, new Set([declaring, ...(registeredIn.get(name) ?? [])]));
    }

    // Pass 3 — who names them. Only imports count: a same-named local binding
    // in another plugin is a different symbol, not a reach into this one.
    const references = await listCandidateSources({
      root,
      grepArg: [...owners.keys()].join("|"),
      pathspecs: PATHSPECS,
    });

    const offenders: string[] = [];
    for (const { rel, src } of references) {
      for (const imp of findImports(src)) {
        if (imp.sideEffect) continue;
        for (const [name, allowed] of owners) {
          if (!new RegExp(`\\b${name}\\b`).test(imp.clause)) continue;
          const inside = [...allowed].some(
            (dir) => rel === dir || rel.startsWith(`${dir}/`),
          );
          if (inside) continue;
          offenders.push(
            `${rel} imports \`${name}\` from "${imp.specifier}" (owned by ${[...allowed].sort().join(", ")})`,
          );
        }
      }
    }

    if (offenders.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `${offenders.length} file(s) outside a token family's own plugin name that family's ` +
        `identity:\n    ${[...new Set(offenders)].sort().join("\n    ")}`,
      hint:
        "Read the registry instead of the family. A surface that renders tokens takes the " +
        "whole contributed set — `getBlockTextExtensions()` (web) / `blockTextServerExtensions()` " +
        "(server) — and scans with `matchTokens(text, marks, extensions)`; a surface that renders " +
        "one already-matched token calls the owner's `renderToken`. Naming one family means the " +
        "set you handle is closed at the moment you wrote it, and the next family to ship renders " +
        "as literal characters with nothing failing — which is exactly how `[[date:…]]` shipped " +
        "as visible brackets on every read-only page surface.",
    };
  },
};

export default noTokenIdentityOutsideOwner;
