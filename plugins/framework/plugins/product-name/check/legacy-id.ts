import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
// Own-plugin, so relative (same shape as `namespace/check`).
import {
  LEGACY_IDS,
  LEGACY_ID_NOTES,
  type LegacyIdKey,
} from "../core/internal/legacy-ids";
import { PRODUCT_NAME } from "../core/internal/product-name";

const RULE = "product-name:legacy-id";

/** The old name, in any case: an identifier, a scope, a key, a path, prose. */
const OLD_NAME = /singularity/i;

/**
 * Spellings still allowed outside the owner, because they name something
 * outside the repo's control.
 */
const ALLOWED: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  // The repository keeps its name; a URL to it is the remote's, not ours.
  {
    pattern: /(?:github|gitlab)(?:usercontent)?\.com[/:][\w.-]+\/singularity/gi,
    why: "a repository URL",
  },
];

/** Which kept values each mirror file may spell. */
const MIRROR_VALUES: ReadonlyMap<string, readonly string[]> = (() => {
  const byFile = new Map<string, string[]>();
  for (const [key, note] of Object.entries(LEGACY_ID_NOTES)) {
    for (const file of note.mirrors ?? []) {
      const values = byFile.get(file) ?? [];
      values.push(LEGACY_IDS[key as LegacyIdKey]);
      byFile.set(file, values);
    }
  }
  return byFile;
})();

export function offendingLine(
  text: string,
  mirrored: readonly string[],
): boolean {
  let rest = text;
  for (const { pattern } of ALLOWED) rest = rest.replace(pattern, "");
  if (!OLD_NAME.test(rest)) return false;
  return !mirrored.some((value) => rest.includes(value));
}

/**
 * The old name survives only where it is stored state or a cross-version
 * contract, and there it is spelled once, in `LEGACY_IDS`. Everything else — a
 * package scope, a manifest key, a camelCase identifier, a temp prefix, a
 * comment — says `equin` or names the kept id through the owner. Nothing breaks
 * when a new `singularity` appears, so without this check nothing would notice.
 */
const legacyIdCheck: Check = {
  id: RULE,
  // INPUT-KEYED: a pure function of the `git grep -l` selection, its
  // candidates' content and the exemption manifests — all recorded.
  inputKeyed: true,
  description:
    "the old name appears only in LEGACY_IDS (kept stored ids and contracts) and the mirror files it declares",
  exemptable: {
    [RULE]:
      "spells the old name on purpose — stored history (committed migrations) or the owner of the kept ids",
  },
  outOfScope: ["research", "generated"],
  async run(ctx) {
    const exempt = await ctx.exempt(RULE);
    const offenders: string[] = [];
    const candidates = await listCandidateSources({
      grepArg: "[Ss][Ii][Nn][Gg][Uu][Ll][Aa][Rr][Ii][Tt][Yy]",
      pathspecs: ["."],
    });
    for (const { rel, src } of candidates) {
      if (exempt.skips(rel)) continue;
      const mirrored = MIRROR_VALUES.get(rel) ?? [];
      src.split("\n").forEach((text, i) => {
        if (offendingLine(text, mirrored)) {
          offenders.push(`${rel}:${i + 1}:${text.trim()}`);
        }
      });
    }

    if (offenders.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${offenders.length} line(s) spelling the old name:\n    ${offenders.join("\n    ")}`,
      hint:
        `A name the same build produces and reads (a package scope, a key, an identifier, a temp prefix) is renamed — derive it from \`PRODUCT_NAME\` ("${PRODUCT_NAME}"). ` +
        'A kept stored id or cross-version contract is read from `LEGACY_IDS` (`@plugins/framework/plugins/product-name/core`), never spelled; prose names the concept ("the main namespace", "the push trailer"). ' +
        "A file that cannot import it (Go, Rust, shell) is listed in that id's `mirrors` in `legacy-ids.ts`. " +
        `Also allowed: ${ALLOWED.map((a) => a.why).join(", ")}.`,
    };
  },
};

/**
 * The other half: a mirror is allowed to spell its kept ids only because it
 * cannot import them, so it must keep spelling exactly the owner's value — a
 * drifted Go or Rust copy is a gateway or a menu-bar helper looking for a
 * namespace, a label or a lock dir that is not there.
 */
const legacyIdsInSyncCheck: Check = {
  id: "product-name:legacy-ids-in-sync",
  description:
    "every mirror file LEGACY_IDS declares still spells the kept value it mirrors",
  async run() {
    const root = await getWorktreeRoot();
    const drift: string[] = [];
    for (const [key, note] of Object.entries(LEGACY_ID_NOTES)) {
      const value = LEGACY_IDS[key as LegacyIdKey];
      for (const file of note.mirrors ?? []) {
        const text = await readFile(join(root, file), "utf8");
        if (!text.includes(value)) {
          drift.push(`${file} — no longer spells ${key} (${value})`);
        }
      }
    }
    if (drift.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${drift.length} mirror(s) out of sync with LEGACY_IDS:\n    ${drift.join("\n    ")}`,
      hint: "Spell the owner's value in the mirror, or — if the file no longer needs it — drop the file from that id's `mirrors` in `plugins/framework/plugins/product-name/core/internal/legacy-ids.ts`.",
    };
  },
};

export default [legacyIdCheck, legacyIdsInSyncCheck];
