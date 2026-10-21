import { readFileSync } from "fs";
import { join } from "path";
import { writeGenerated } from "./write-generated";
import { appCssPath, collectUtilityDecls } from "./app-css-utilities";

/**
 * Generates `custom-utilities.generated.ts` — the twMerge registry consumed by
 * `cn()` (lib/utils.ts) — from the `/* twmerge: … *\/` markers in app.css.
 *
 * app.css is the SINGLE SOURCE OF TRUTH for both membership (which custom
 * `@utility` classes exist) and classification (how tailwind-merge must treat
 * each). Adding a custom `@utility` is then ONE edit at the declaration site; the
 * old hand-maintained name-mirroring registry (custom-utilities.ts) is deleted,
 * so the membership-drift bug class becomes structurally impossible.
 *
 * Mirrors the token-group-vars-gen trio: `renderCustomUtilities` (in-memory),
 * `generateCustomUtilities` (write-on-diff), `customUtilitiesManifestPath`.
 *
 * A synthetic group states its relation to the built-in groups as `excludes:`
 * (mutual — whichever class is last survives, in EITHER order) and, as the escape
 * hatch, `under: <builtin…> -- <reason>` (the built-in is strictly broader, so it
 * removes the group but the group must not remove it). The generator only records
 * what the decl says; `lib/utils.ts` compiles it to tailwind-merge's directional
 * `conflictingClassGroups` and closes it over tailwind-merge's own map, which is
 * why nothing here needs to know that `p` is broader than `px`.
 *
 * The generator reads app.css by PATH via fs — it must NOT statically import the
 * ui-kit plugin (that would be an illegal framework→ui cross-plugin edge), so it
 * owns its own copy of the builtin-group-id allow-list (kept in sync with
 * `BuiltinGroupId` in custom-utilities-types.ts).
 */

const MANIFEST_REL_PATH =
  "plugins/primitives/plugins/css/plugins/ui-kit/web/theme/custom-utilities.generated.ts";

// The fixed allow-list of built-in tailwind-merge group ids the project extends.
// Keep in sync with `BuiltinGroupId` in
// plugins/primitives/plugins/css/plugins/ui-kit/web/theme/custom-utilities-types.ts.
const BUILTIN_GROUP_IDS = new Set([
  "font-size",
  "font-weight",
  "z",
  "h",
  "w",
  "size",
  "min-h",
  "p",
  "px",
  "py",
  "pt",
  "pr",
  "pb",
  "pl",
  "gap",
  "gap-x",
  "gap-y",
  "rounded",
  "shadow",
  "animate",
  "border-w-b",
  "backdrop-filter",
  "backdrop-blur",
  "backdrop-brightness",
  "backdrop-contrast",
  "backdrop-grayscale",
  "backdrop-hue-rotate",
  "backdrop-invert",
  "backdrop-opacity",
  "backdrop-saturate",
  "backdrop-sepia",
]);

const MANIFEST_HEADER = [
  "// AUTO-GENERATED from app.css @utility `/* twmerge: … */` markers. Do not edit.",
  "// Run `./singularity build` to regenerate.",
  "// (see plugins/framework/plugins/tooling/plugins/codegen/core/custom-utilities-gen.ts).",
  "//",
  "// The twMerge registry consumed by cn() (lib/utils.ts), derived from app.css —",
  "// the single source of truth for which custom @utility classes exist and how",
  "// tailwind-merge must classify each.",
  "//",
  "// The `app-css-utilities-in-sync` check fails on drift.",
].join("\n");

type Marker =
  | { kind: "extend"; builtin: string }
  | { kind: "group"; group: string }
  | { kind: "standalone"; reason: string };

interface UnderRelation {
  group: string;
  reason: string;
}

type RegistryEntry =
  | { classes: string[]; extend: string }
  | {
      classes: string[];
      group: string;
      excludes: string[];
      under: UnderRelation[];
    }
  | { classes: string[]; standalone: true; reason: string };

/** A synthetic-group declaration scanned file-wide from a section header. */
interface GroupDecl {
  id: string;
  /** Built-ins this group is MUTUALLY exclusive with (both directions). */
  excludes: string[];
  /**
   * Built-ins that are strictly BROADER than this group: a later built-in removes
   * the group, a later group member does NOT remove the built-in. The escape
   * hatch, so each one carries a required reason.
   */
  under: UnderRelation[];
}

/**
 * Parse a single `/* twmerge: <ref> *\/` marker body into a structured Marker.
 * Throws on an unknown ref shape, an unknown builtin id, or an empty standalone
 * reason. `where` names the `@utility` for the error message.
 */
function parseMarker(ref: string, where: string): Marker {
  const trimmed = ref.trim();
  const extendMatch = /^extend\s+([\w-]+)$/.exec(trimmed);
  if (extendMatch) {
    const builtin = extendMatch[1]!;
    if (!BUILTIN_GROUP_IDS.has(builtin)) {
      throw new Error(
        `app.css @utility ${where}: unknown built-in tailwind-merge group "${builtin}" in marker "extend ${builtin}". ` +
          `Allowed: ${[...BUILTIN_GROUP_IDS].join(", ")}.`,
      );
    }
    return { kind: "extend", builtin };
  }
  const standaloneMatch = /^standalone\s*--\s*(.+)$/s.exec(trimmed);
  if (standaloneMatch) {
    const reason = standaloneMatch[1]!.trim();
    if (!reason) {
      throw new Error(
        `app.css @utility ${where}: marker "standalone" requires a non-empty reason ("standalone -- <reason>").`,
      );
    }
    return { kind: "standalone", reason };
  }
  // Anything else is a synthetic-group id reference; validity (must match a group
  // decl) is checked after group decls are collected.
  if (/^[\w-]+$/.test(trimmed)) {
    return { kind: "group", group: trimmed };
  }
  throw new Error(
    `app.css @utility ${where}: unrecognized twmerge marker "${trimmed}". ` +
      `Expected "extend <builtin>", "<sg-id>", or "standalone -- <reason>".`,
  );
}

function assertBuiltin(id: string, group: string, clause: string): void {
  if (!BUILTIN_GROUP_IDS.has(id)) {
    throw new Error(
      `app.css @twmerge group ${group}: unknown built-in tailwind-merge group "${id}" in the ${clause} list. ` +
        `Allowed: ${[...BUILTIN_GROUP_IDS].join(", ")}.`,
    );
  }
}

/**
 * Scan every `/* @twmerge group <id> excludes: <ids…> [under: <ids…> -- <why>] *\/`
 * decl file-wide.
 *
 * A decl's body runs from its `@twmerge group <id>` header to whichever comes
 * first: the next `@twmerge` header, or the end of the enclosing comment. That
 * boundary (rather than end-of-line) is what lets a `under:` reason wrap across
 * lines; the leading ` * ` of each continuation line is stripped.
 *
 * The removed `conflicts:` spelling is rejected explicitly rather than ignored:
 * it compiled to a ONE-directional rule (a later built-in removes the group, never
 * the reverse), which is the bug `excludes:` exists to fix — so a marker must not
 * be able to keep the old semantics by keeping the old word.
 */
function collectGroupDecls(css: string): Map<string, GroupDecl> {
  const decls = new Map<string, GroupDecl>();
  const headers = [...css.matchAll(/@twmerge\s+group\s+([\w-]+)/g)];

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!;
    const id = header[1]!;
    const bodyStart = header.index! + header[0].length;
    const nextHeader = headers[i + 1]?.index ?? css.length;
    const commentEnd = css.indexOf("*/", bodyStart);
    const bodyEnd = Math.min(
      nextHeader,
      commentEnd === -1 ? css.length : commentEnd,
    );
    // Strip each continuation line's ` * ` comment gutter, then flatten to one line.
    const body = css
      .slice(bodyStart, bodyEnd)
      .split("\n")
      .map((line, index) =>
        index === 0 ? line : line.replace(/^\s*\*\s?/, ""),
      )
      .join(" ");

    if (/\bconflicts\s*:/.test(body)) {
      throw new Error(
        `app.css @twmerge group ${id}: "conflicts:" no longer exists — it compiled to a ` +
          `one-directional rule (a later built-in removed the group, never the reverse), so a ` +
          `group and a built-in could both survive on one element. Use "excludes: <builtin…>" ` +
          `for mutual exclusion, or "under: <builtin…> -- <reason>" when the built-in is ` +
          `strictly broader and must not be removed by this group.`,
      );
    }

    const decl: GroupDecl = { id, excludes: [], under: [] };
    // Split the body into clauses, keeping each keyword with its own segment.
    const clauses = body.split(/\b(excludes|under)\s*:/);
    for (let c = 1; c < clauses.length; c += 2) {
      const keyword = clauses[c]!;
      const segment = clauses[c + 1] ?? "";
      if (keyword === "excludes") {
        const ids = segment.trim().split(/\s+/).filter(Boolean);
        if (ids.length === 0) {
          throw new Error(
            `app.css @twmerge group ${id}: "excludes:" needs at least one built-in group id.`,
          );
        }
        for (const builtin of ids) {
          if (!/^[\w-]+$/.test(builtin)) {
            throw new Error(
              `app.css @twmerge group ${id}: "${builtin}" is not a group id in the excludes list.`,
            );
          }
          assertBuiltin(builtin, id, "excludes");
        }
        decl.excludes.push(...ids);
        continue;
      }
      const [target, ...reasonParts] = segment.split("--");
      const reason = reasonParts.join("--").trim();
      const ids = target!.trim().split(/\s+/).filter(Boolean);
      if (ids.length === 0) {
        throw new Error(
          `app.css @twmerge group ${id}: "under:" needs at least one built-in group id.`,
        );
      }
      if (!reason) {
        throw new Error(
          `app.css @twmerge group ${id}: "under: ${ids.join(" ")}" requires a reason ` +
            `("under: <builtin…> -- <reason>"). It is the one-directional escape — say why ` +
            `the built-in is strictly broader than this group.`,
        );
      }
      for (const builtin of ids) {
        assertBuiltin(builtin, id, "under");
        decl.under.push({ group: builtin, reason });
      }
    }

    if (decl.excludes.length === 0 && decl.under.length === 0) {
      throw new Error(
        `app.css @twmerge group ${id}: declaration has no recognised clause. ` +
          `Expected "excludes: <builtin…>" and/or "under: <builtin…> -- <reason>".`,
      );
    }
    decls.set(id, decl);
  }
  return decls;
}

/**
 * Parse app.css into the ordered registry. Brace-counting-free: locate each real
 * `@utility` declaration (ignoring prose mentions inside comments), then read its
 * marker as the first `/* twmerge: … *\/` comment in the slice between that
 * declaration and the next one (or EOF). Consecutive records sharing an identical
 * marker coalesce into one entry, preserving file order.
 */
export function parseCustomUtilities(css: string): RegistryEntry[] {
  const groupDecls = collectGroupDecls(css);

  // Real @utility declaration offsets (comment-masked scan, shared with the
  // other app.css-derived generators), then slice the ORIGINAL css between
  // consecutive declarations to recover each marker.
  const decls = collectUtilityDecls(css);

  type Record = { name: string; marker: Marker };
  const records: Record[] = [];

  for (let i = 0; i < decls.length; i++) {
    const { name, start } = decls[i]!;
    const end = i + 1 < decls.length ? decls[i + 1]!.start : css.length;
    const slice = css.slice(start, end);
    const markerMatch = /\/\*\s*twmerge:\s*([\s\S]*?)\*\//.exec(slice);
    if (!markerMatch) {
      throw new Error(
        `app.css @utility ${name}: missing a "/* twmerge: <ref> */" marker. ` +
          `Add one of: "/* twmerge: extend <builtin> */", "/* twmerge: <sg-id> */", ` +
          `or "/* twmerge: standalone -- <reason> */" co-located with the declaration.`,
      );
    }
    records.push({ name, marker: parseMarker(markerMatch[1]!, name) });
  }

  // Validate every sg-id reference has a matching group decl.
  for (const rec of records) {
    if (rec.marker.kind === "group" && !groupDecls.has(rec.marker.group)) {
      throw new Error(
        `app.css @utility ${rec.name}: twmerge marker "${rec.marker.group}" has no ` +
          `matching "/* @twmerge group ${rec.marker.group} excludes: … */" declaration.`,
      );
    }
  }

  // Coalesce consecutive records with an identical marker into one entry.
  const entries: RegistryEntry[] = [];
  let current: { key: string; entry: RegistryEntry } | null = null;
  const markerKey = (m: Marker): string =>
    m.kind === "extend"
      ? `extend:${m.builtin}`
      : m.kind === "group"
        ? `group:${m.group}`
        : `standalone:${m.reason}`;

  for (const rec of records) {
    const key = markerKey(rec.marker);
    if (current && current.key === key) {
      current.entry.classes.push(rec.name);
      continue;
    }
    let entry: RegistryEntry;
    if (rec.marker.kind === "extend") {
      entry = { classes: [rec.name], extend: rec.marker.builtin };
    } else if (rec.marker.kind === "group") {
      const decl = groupDecls.get(rec.marker.group)!;
      entry = {
        classes: [rec.name],
        group: rec.marker.group,
        excludes: decl.excludes,
        under: decl.under,
      };
    } else {
      entry = {
        classes: [rec.name],
        standalone: true,
        reason: rec.marker.reason,
      };
    }
    entries.push(entry);
    current = { key, entry };
  }

  return entries;
}

function renderEntry(entry: RegistryEntry): string {
  const classes = entry.classes.map((c) => JSON.stringify(c)).join(", ");
  if ("extend" in entry) {
    return `  { classes: [${classes}], extend: ${JSON.stringify(entry.extend)} },`;
  }
  if ("group" in entry) {
    const excludes = entry.excludes.map((c) => JSON.stringify(c)).join(", ");
    const under = entry.under
      .map(
        (u) =>
          `{ group: ${JSON.stringify(u.group)}, reason: ${JSON.stringify(u.reason)} }`,
      )
      .join(", ");
    // Always emitted, even empty: an omitted field would be absent from the
    // `as const` literal type, so reading `entry.under` on the registry union
    // would not type-check.
    return `  { classes: [${classes}], group: ${JSON.stringify(entry.group)}, excludes: [${excludes}], under: [${under}] },`;
  }
  return `  { classes: [${classes}], standalone: true, reason: ${JSON.stringify(entry.reason)} },`;
}

function renderManifest(entries: RegistryEntry[]): string {
  const lines: string[] = [];
  lines.push(MANIFEST_HEADER);
  lines.push("");
  lines.push('import type { RegistryEntry } from "./custom-utilities-types";');
  lines.push("");
  lines.push("export const CUSTOM_UTILITY_REGISTRY = [");
  for (const entry of entries) lines.push(renderEntry(entry));
  lines.push("] as const satisfies readonly RegistryEntry[];");
  lines.push("");
  lines.push(
    "// Synthetic group ids (for extendTailwindMerge's generic type parameter).",
  );
  lines.push(
    'export type CustomGroupId = Extract<(typeof CUSTOM_UTILITY_REGISTRY)[number], { group: string }>["group"];',
  );
  lines.push("");
  return lines.join("\n");
}

/** Path to the committed generated manifest file. */
export function customUtilitiesManifestPath(root: string): string {
  return join(root, MANIFEST_REL_PATH);
}

/** Render the manifest file contents in-memory (used by the in-sync check). */
export function renderCustomUtilities(root: string): string {
  const css = readFileSync(appCssPath(root), "utf8");
  const entries = parseCustomUtilities(css);
  return renderManifest(entries);
}

/** Regenerate `custom-utilities.generated.ts` if it drifted. */
export async function generateCustomUtilities(opts: {
  root: string;
}): Promise<void> {
  await writeGenerated({
    file: customUtilitiesManifestPath(opts.root),
    content: renderCustomUtilities(opts.root),
  });
}
