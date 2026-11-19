/**
 * The built-ins newer than the browser floor, read once per process from MDN's
 * browser-compat-data (`javascript.builtins.*` and `api.*`, two levels deep:
 * an interface or builtin, and its members), and the regular-expression syntax
 * newer than it (`javascript.regular_expressions.*`, two levels deep).
 *
 * A member is listed only under an owner that itself meets the floor: every
 * member of a newer owner is reached through that owner (its constructor, or
 * the newer member returning it), which is reported already.
 */
import { createRequire } from "node:module";
import {
  BROWSER_FLOOR,
  BROWSER_LABEL,
  type FloorBrowser,
} from "./browser-floor";

/** One newer-than-floor built-in. */
export interface AboveFloor {
  /** The compat-data key, `api.URL.canParse_static`. */
  key: string;
  /** The floor browsers lacking it and the version that brings it: `Safari 17, iOS Safari 17`. */
  needs: string;
}

export interface AboveFloorTable {
  /** owner (`URL`, `Set`, `Element`) → member → entry. */
  members: ReadonlyMap<string, ReadonlyMap<string, AboveFloor>>;
  /** Global names: a newer owner itself (`URLPattern`), or a newer global function (`structuredClone`). */
  globals: ReadonlyMap<string, AboveFloor>;
  /** Every member name of `members`, the syntactic gate. */
  memberNames: ReadonlySet<string>;
  /**
   * Regular-expression syntax newer than the floor, by its compat-data key
   * under `javascript.regular_expressions` (`modifier`,
   * `named_capturing_group.duplicate_named_capturing_groups`). A flag is a
   * `RegExp` member (`unicodeSets` for `v`), in `members`.
   */
  regexpSyntax: ReadonlyMap<string, AboveFloor>;
}

interface SupportStatement {
  version_added?: string | boolean | null;
  version_removed?: string | boolean | null;
  flags?: unknown;
  prefix?: string;
  alternative_name?: string;
}

interface CompatNode {
  __compat?: {
    support?: Partial<
      Record<string, SupportStatement | readonly SupportStatement[]>
    >;
    status?: { deprecated?: boolean };
  };
  [key: string]: unknown;
}

function versionParts(v: string): number[] {
  return v.replace(/^≤/, "").split(".").map(Number);
}

function lessThan(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** A statement's unflagged, unprefixed, own-name shipping range, if it has one. */
function shippedRange(
  s: SupportStatement,
): { added: number[]; removed: number[] | null } | null {
  if (s.flags !== undefined || s.prefix !== undefined) return null;
  if (s.alternative_name !== undefined) return null;
  const added = s.version_added;
  if (typeof added !== "string" || added === "preview") return null;
  const removed = s.version_removed;
  if (removed === true) return null;
  return {
    added: versionParts(added),
    removed:
      typeof removed === "string" && removed !== "preview"
        ? versionParts(removed)
        : null,
  };
}

const FLOOR_BROWSERS = Object.keys(BROWSER_FLOOR) as FloorBrowser[];

/**
 * Whether a browser at version `floor` has the feature, and if not, from which
 * version it does (null: not shipped). A statement whose range ended
 * (`version_removed`) still counts when the floor falls inside it — the data
 * splits one feature into ranges (`KeyboardEvent.repeat`: partial before
 * Chrome 137, complete after). A partial implementation counts as shipped.
 */
function atFloor(
  support: SupportStatement | readonly SupportStatement[] | undefined,
  floor: readonly number[],
): { ok: true } | { ok: false; shipped: number[] | null } {
  if (support === undefined) return { ok: false, shipped: null };
  const statements = Array.isArray(support)
    ? (support as readonly SupportStatement[])
    : [support as SupportStatement];
  let shipped: number[] | null = null;
  for (const statement of statements) {
    const range = shippedRange(statement);
    if (range === null) continue;
    if (
      !lessThan(floor, range.added) &&
      (range.removed === null || lessThan(floor, range.removed))
    )
      return { ok: true };
    if (
      range.removed === null &&
      (shipped === null || lessThan(range.added, shipped))
    )
      shipped = range.added;
  }
  return { ok: false, shipped };
}

/** The floor browsers lacking `node`, in words; null when it meets the floor. */
function missing(node: CompatNode): string | null {
  const support = node.__compat?.support;
  if (support === undefined) return null;
  const lacking: string[] = [];
  for (const browser of FLOOR_BROWSERS) {
    const verdict = atFloor(
      support[browser],
      versionParts(BROWSER_FLOOR[browser]),
    );
    if (verdict.ok) continue;
    lacking.push(
      `${BROWSER_LABEL[browser]} ${verdict.shipped === null ? "(none yet)" : verdict.shipped.join(".")}`,
    );
  }
  return lacking.length === 0 ? null : lacking.join(", ");
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Where the global functions of a page and a worker hang in the data. */
const GLOBAL_SCOPES = new Set(["Window", "WorkerGlobalScope"]);

function build(data: {
  api: Record<string, CompatNode>;
  javascript: {
    builtins: Record<string, CompatNode>;
    regular_expressions: Record<string, CompatNode>;
  };
}): AboveFloorTable {
  const members = new Map<string, Map<string, AboveFloor>>();
  const globals = new Map<string, AboveFloor>();
  const memberNames = new Set<string>();
  const roots: [string, Record<string, CompatNode>][] = [
    ["api", data.api],
    ["javascript.builtins", data.javascript.builtins],
  ];
  for (const [prefix, root] of roots) {
    for (const [owner, ownerNode] of Object.entries(root)) {
      if (!IDENTIFIER.test(owner)) continue;
      const ownerNeeds = missing(ownerNode);
      if (ownerNeeds !== null) {
        if (ownerNode.__compat?.status?.deprecated !== true)
          globals.set(owner, { key: `${prefix}.${owner}`, needs: ownerNeeds });
        continue;
      }
      for (const [rawMember, memberNode] of Object.entries(ownerNode)) {
        if (rawMember === "__compat") continue;
        const member = rawMember.replace(/_static$/, "");
        if (!IDENTIFIER.test(member)) continue;
        const node = memberNode as CompatNode;
        if (node.__compat?.status?.deprecated === true) continue;
        const needs = missing(node);
        if (needs === null) continue;
        const entry = { key: `${prefix}.${owner}.${rawMember}`, needs };
        let own = members.get(owner);
        if (own === undefined) members.set(owner, (own = new Map()));
        own.set(member, entry);
        memberNames.add(member);
        if (prefix === "api" && GLOBAL_SCOPES.has(owner))
          globals.set(member, entry);
      }
    }
  }
  const regexpSyntax = new Map<string, AboveFloor>();
  const prefix = "javascript.regular_expressions";
  for (const [feature, node] of Object.entries(
    data.javascript.regular_expressions,
  )) {
    const needs = missing(node);
    if (needs !== null) {
      regexpSyntax.set(feature, { key: `${prefix}.${feature}`, needs });
      continue;
    }
    for (const [sub, subNode] of Object.entries(node)) {
      if (sub === "__compat") continue;
      const subNeeds = missing(subNode as CompatNode);
      if (subNeeds !== null)
        regexpSyntax.set(`${feature}.${sub}`, {
          key: `${prefix}.${feature}.${sub}`,
          needs: subNeeds,
        });
    }
  }
  return { members, globals, memberNames, regexpSyntax };
}

let table: AboveFloorTable | undefined;

/**
 * The table, built on first use. The data is ~20 MB of JSON: it is dropped
 * from the module cache once read, so a lint process keeps only the table
 * (~1.5k entries).
 */
export function aboveFloorTable(): AboveFloorTable {
  if (table !== undefined) return table;
  const require = createRequire(import.meta.url);
  // Literal specifiers: the type-check lint cache keys this rule's group on
  // the npm packages its files load, read from them by name.
  table = build(
    require("@mdn/browser-compat-data") as Parameters<typeof build>[0],
  );
  delete require.cache[require.resolve("@mdn/browser-compat-data")];
  return table;
}
