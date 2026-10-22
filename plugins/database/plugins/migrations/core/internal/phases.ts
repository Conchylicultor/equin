// The phased-migration file grammar: the one spelling shared by the generator
// that writes it (cli/plugins/migrations) and the runner that reads it
// (migrations/server). See research/2026-09-29-global-phased-migrations.md.
//
// A phased schema migration is drizzle's generated DDL, split at generation time
// into an `expand` section (permissive: existing rows and code stay valid) and a
// `contract` section (restrictive or data-destroying), plus the branch-local data
// migrations it claims. The runner applies one push as ONE group:
//
//   expand → claimed data migrations (timestamp order) → contract
//
// Every file without the header — everything written before this grammar, and
// every data migration — is `legacy`: applied whole, at its own timestamp.
//
//   -- singularity:phase expand
//   CREATE TABLE IF NOT EXISTS "x" (...);
//   -- singularity:phase contract
//   ALTER TABLE "agents" DROP COLUMN IF EXISTS "icon_svg_nodes";
//   -- singularity:claims
//   -- 20260927_182347__remap_saved_icons_to_symbols
//
// A claim names a data migration by `<YYYYMMDD_HHMMSS>__<slug>` — its filename
// minus the content hash, because a branch-local data migration is re-hashed on
// every build while its timestamp and slug never change.
//
// SNAPSHOT LINEAGE (research/2026-10-22-global-single-live-migration-snapshot.md).
// Every schema migration written since the snapshot cutover names its drizzle
// snapshot on its first line: the snapshot's id and its parent ids.
//
//   -- singularity:snapshot id=<uuid> parents=<uuid>            (ordinary)
//   -- singularity:snapshot id=<uuid> parents=<uuidA>,<uuidB>   (merge node)
//   -- singularity:phase expand
//   ...
//
// The header is the schema-migration marker (a file with it is a schema
// migration; before the cutover, `meta/legacy-snapshots.json` says so) and the
// one record of the snapshot DAG's edges: only the TIP's body is on disk
// (`meta/schema.snapshot.json`), older ones are read from git. A root names the
// null id as its one parent.
//
// A MERGE NODE (research/2026-09-30-global-clone-migrations-published-set.md
// §3) is a header with two or more parents over an empty phased migration with
// no claims:
//
//   -- singularity:snapshot id=<derived> parents=<snapshotIdA>,<snapshotIdB>
//   -- singularity:phase expand
//   -- singularity:phase contract
//   -- singularity:claims
//
// Its SQL does nothing — each side's own migrations already apply that side's
// DDL — and its snapshot is the 3-way merge of the parents.
//
// SUPERSESSION (research/2026-10-20-global-merged-migration-supersedes-authored.md).
// A reset (push's regen, `--reset-migration`) deletes the branch's own schema
// migrations and regenerates their delta as one new file with a new hash. A
// database that applied the deleted files already carries that delta, and the
// ledger is keyed by hash — so the new file records which hashes it replaced:
//
//   -- singularity:supersedes 38bc8c97 f09303fa
//   -- singularity:supersedes a1b2c3d4 <- 0badf00d 12345678
//   -- singularity:phase expand
//   ...
//
// The first form (exactly one line) lists the files this reset deleted. The
// `<-` form is inherited: a deleted file that had itself superseded others
// passes its own lineage on, so a regen of a regen still reaches the hashes a
// database actually applied. The runner adopts the file (records it, runs none
// of its SQL) when its lineage is fully applied. The generator writes the
// header only when it proved the deleted files expressed the same schema.
//
// ADOPTION (research/2026-10-21-global-reset-adopts-published-migration.md).
// A reset whose delta already landed on main through someone else's published
// migration regenerates nothing — and that published file then redoes, in a
// database that applied the deleted ones, DDL that is already there. The reset
// writes an adoption file instead: empty sections, the lineage, and one more
// line naming the published files whose combined delta the lineage applied:
//
//   -- singularity:adopts 5d1f2e3a 77aa01bc
//   -- singularity:supersedes 38bc8c97 f09303fa
//   -- singularity:phase expand
//   -- singularity:phase contract
//   -- singularity:claims
//
// Where the lineage is fully applied, the runner records the adopted files
// without running their DDL; anywhere else the file is a no-op record.

const SNAPSHOT_HEADER = "-- singularity:snapshot";
const SNAPSHOT_HEADER_RE =
  /^-- singularity:snapshot id=([0-9a-f-]+) parents=([0-9a-f-]+(?:,[0-9a-f-]+)*)$/;
const SNAPSHOT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const EXPAND = "-- singularity:phase expand";
const CONTRACT = "-- singularity:phase contract";
const CLAIMS = "-- singularity:claims";
const SUPERSEDES = "-- singularity:supersedes";
const ADOPTS = "-- singularity:adopts";
const HASH_RE = /^[0-9a-f]{8}$/;

const MIGRATION_FILE_RE = /^(\d{8})_(\d{6})_([0-9a-f]{8})__(.+)\.sql$/;
const CLAIM_ID_RE = /^\d{8}_\d{6}__[a-z0-9_]+$/;

// The hashes a phased migration replaced (see SUPERSESSION above). `direct` is
// never empty; every `inherited` entry's hash is reachable from `direct`.
export interface Supersession {
  direct: readonly string[];
  inherited: readonly { hash: string; replaced: readonly string[] }[];
}

export interface PhasedMigration {
  expand: string;
  contract: string;
  claims: readonly string[];
  supersedes: Supersession | null;
}

// A parsed phased migration also names the published files it adopts (see
// ADOPTION above): empty for every file but an adoption file.
export type ParsedMigration =
  | { kind: "legacy"; sql: string }
  | ({ kind: "phased"; adopts: readonly string[] } & PhasedMigration);

// The claim id of a migration file: its name without the content hash.
export function migrationClaimId(file: string): string {
  const m = MIGRATION_FILE_RE.exec(file);
  if (!m) throw new Error(`not a migration filename: ${file}`);
  return `${m[1]}_${m[2]}__${m[4]}`;
}

function assertClaimId(id: string): void {
  if (!CLAIM_ID_RE.test(id))
    throw new Error(`malformed migration claim: "${id}"`);
}

// Render the sections into the file body the generator writes (and hashes).
// Each section is the statements' SQL, verbatim; an empty section is written
// empty so the file always carries all three markers.
export function renderPhasedMigration(m: PhasedMigration): string {
  for (const c of m.claims) assertClaimId(c);
  const section = (s: string) => (s.trim() === "" ? "" : `${s.trim()}\n`);
  return (
    renderSupersession(m.supersedes) +
    `${EXPAND}\n${section(m.expand)}` +
    `${CONTRACT}\n${section(m.contract)}` +
    `${CLAIMS}\n${m.claims.map((c) => `-- ${c}\n`).join("")}`
  );
}

/** A schema migration's snapshot id and the snapshot ids it descends from. */
export interface SnapshotLineage {
  id: string;
  /** One parent for an ordinary migration (the null id for a root), two or more for a merge node. */
  parents: readonly string[];
}

function assertSnapshotId(id: string, line: string): void {
  if (!SNAPSHOT_ID_RE.test(id))
    throw new Error(`malformed snapshot id "${id}" in: ${line}`);
}

// The header line (newline included) a schema migration starts with.
export function renderSnapshotHeader(l: SnapshotLineage): string {
  const line = `${SNAPSHOT_HEADER} id=${l.id} parents=${l.parents.join(",")}`;
  if (l.parents.length === 0)
    throw new Error(`header names no parent: ${line}`);
  for (const id of [l.id, ...l.parents]) assertSnapshotId(id, line);
  if (new Set(l.parents).size !== l.parents.length || l.parents.includes(l.id))
    throw new Error(`header repeats a snapshot id: ${line}`);
  return `${line}\n`;
}

// The body of a merge node with snapshot `id` joining `parents` (snapshot ids,
// in snapshot-file order): the header, then an empty phased migration.
export function renderMergeSnapshotMigration(l: SnapshotLineage): string {
  if (l.parents.length < 2)
    throw new Error(
      `a merge node joins at least two snapshots, got ${l.parents.length}`,
    );
  return (
    renderSnapshotHeader(l) +
    renderPhasedMigration({
      expand: "",
      contract: "",
      claims: [],
      supersedes: null,
    })
  );
}

// The body of an adoption file: `adopts` (published hashes, in timestamp
// order), the lineage that applied their delta, then an empty phased migration.
export function renderAdoptionMigration(
  adopts: readonly string[],
  supersedes: Supersession,
): string {
  assertHashes(adopts, adopts.join(" "));
  return (
    `${ADOPTS} ${adopts.join(" ")}\n` +
    renderPhasedMigration({
      expand: "",
      contract: "",
      claims: [],
      supersedes,
    })
  );
}

function renderSupersession(s: Supersession | null): string {
  if (s === null) return "";
  assertSupersession(s);
  return (
    `${SUPERSEDES} ${s.direct.join(" ")}\n` +
    s.inherited
      .map((e) => `${SUPERSEDES} ${e.hash} <- ${e.replaced.join(" ")}\n`)
      .join("")
  );
}

function assertHashes(hashes: readonly string[], line: string): void {
  if (hashes.length === 0) throw new Error(`header lists no hash: ${line}`);
  for (const h of hashes) {
    if (!HASH_RE.test(h))
      throw new Error(`malformed hash "${h}" in header: ${line}`);
  }
}

// `direct` non-empty, every hash well-formed, each inherited parent listed
// once and reachable from `direct` — an edge nothing reaches could never be
// consulted, so it is a corrupt header, not a harmless extra.
function assertSupersession(s: Supersession): void {
  assertHashes(s.direct, s.direct.join(" "));
  const reachable = new Set(s.direct);
  const seen = new Set<string>();
  for (const e of s.inherited) {
    assertHashes(
      [e.hash, ...e.replaced],
      `${e.hash} <- ${e.replaced.join(" ")}`,
    );
    if (seen.has(e.hash))
      throw new Error(`supersedes header lists ${e.hash}'s lineage twice`);
    seen.add(e.hash);
  }
  // Fixed point: an edge may be listed before the edge that reaches it.
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of s.inherited) {
      if (!reachable.has(e.hash)) continue;
      for (const r of e.replaced) {
        if (!reachable.has(r)) {
          reachable.add(r);
          grew = true;
        }
      }
    }
  }
  for (const e of s.inherited) {
    if (!reachable.has(e.hash))
      throw new Error(
        `supersedes header has a lineage for ${e.hash}, which nothing it supersedes reaches`,
      );
  }
}

// Split the leading supersedes lines off `sql`: the lineage (null when there
// is none) and the body after it.
function takeSupersession(sql: string): {
  supersedes: Supersession | null;
  body: string;
} {
  const lines = sql.split("\n");
  let i = 0;
  let direct: string[] | null = null;
  const inherited: { hash: string; replaced: string[] }[] = [];
  while (i < lines.length && lines[i]!.startsWith(SUPERSEDES)) {
    const line = lines[i]!.trimEnd();
    const rest = line.slice(SUPERSEDES.length);
    if (!rest.startsWith(" "))
      throw new Error(`malformed supersedes header: ${line}`);
    const [lhs, rhs, ...more] = rest.split(" <- ");
    if (more.length > 0)
      throw new Error(`malformed supersedes header: ${line}`);
    const left = lhs!.trim().split(/\s+/);
    if (rhs === undefined) {
      if (direct !== null)
        throw new Error(
          `supersedes header has two direct lines; the second is: ${line}`,
        );
      assertHashes(left, line);
      direct = left;
    } else {
      if (left.length !== 1)
        throw new Error(
          `an inherited supersedes line names one replaced file: ${line}`,
        );
      inherited.push({ hash: left[0]!, replaced: rhs.trim().split(/\s+/) });
    }
    i++;
  }
  if (i === 0) return { supersedes: null, body: sql };
  if (direct === null)
    throw new Error(
      `supersedes header has inherited lines but no direct line (\`${SUPERSEDES} <hash>…\`)`,
    );
  const supersedes = { direct, inherited };
  assertSupersession(supersedes);
  return { supersedes, body: lines.slice(i).join("\n") };
}

// The snapshot lineage a schema migration's first line names; null for a file
// without the header (a data migration, an adoption file, or a schema
// migration from before the cutover). A first line that starts like the header
// but does not parse throws — a DAG edge must never be silently dropped.
export function snapshotLineage(sql: string): SnapshotLineage | null {
  const eol = sql.indexOf("\n");
  const first = (eol === -1 ? sql : sql.slice(0, eol)).trimEnd();
  if (!first.startsWith(SNAPSHOT_HEADER)) return null;
  const m = SNAPSHOT_HEADER_RE.exec(first);
  if (!m) throw new Error(`malformed snapshot header: ${first}`);
  const lineage = { id: m[1]!, parents: m[2]!.split(",") };
  // The renderer's own validation: what parses is exactly what it writes.
  if (renderSnapshotHeader(lineage) !== `${first}\n`)
    throw new Error(`malformed snapshot header: ${first}`);
  return lineage;
}

// Parse a migration file body. A file whose first line is not the expand marker
// is legacy. A file that starts phased but is malformed throws — never degrades
// to legacy, which would silently apply contract before its data. A snapshot
// header line is skipped; what follows it must be phased. Leading
// supersedes lines are the lineage; what follows them must be phased too.
export function parseMigration(sql: string): ParsedMigration {
  if (snapshotLineage(sql) !== null) {
    const eol = sql.indexOf("\n");
    const parsed = eol === -1 ? null : parseMigration(sql.slice(eol + 1));
    if (parsed?.kind !== "phased")
      throw new Error(
        `a migration with a snapshot header must be phased after its header line`,
      );
    return parsed;
  }
  const eol = sql.indexOf("\n");
  const first = (eol === -1 ? sql : sql.slice(0, eol)).trimEnd();
  if (first.startsWith(ADOPTS)) {
    const rest = first.slice(ADOPTS.length);
    if (!rest.startsWith(" "))
      throw new Error(`malformed adopts header: ${first}`);
    const adopts = rest.trim().split(/\s+/);
    assertHashes(adopts, first);
    const parsed = eol === -1 ? null : parseMigration(sql.slice(eol + 1));
    if (parsed?.kind !== "phased" || parsed.supersedes === null)
      throw new Error(
        `an adopts header must be followed by a supersedes header and a phased migration`,
      );
    if (
      parsed.adopts.length > 0 ||
      parsed.expand !== "" ||
      parsed.contract !== "" ||
      parsed.claims.length > 0
    )
      throw new Error(
        `an adoption file records only: its sections and claims must be empty, and it has one adopts line`,
      );
    return { ...parsed, adopts };
  }
  const { supersedes, body } = takeSupersession(sql);
  if (supersedes !== null) {
    const parsed = parsePhasedBody(body);
    if (parsed.kind !== "phased")
      throw new Error(
        `a migration with a supersedes header must be phased after it`,
      );
    return { ...parsed, supersedes };
  }
  return parsePhasedBody(sql);
}

function parsePhasedBody(sql: string): ParsedMigration {
  const lines = sql.split("\n");
  if (lines[0]?.trimEnd() !== EXPAND) return { kind: "legacy", sql };

  const contractAt = lines.findIndex((l) => l.trimEnd() === CONTRACT);
  const claimsAt = lines.findIndex((l) => l.trimEnd() === CLAIMS);
  if (contractAt < 1 || claimsAt < contractAt) {
    throw new Error(
      `phased migration is malformed: expected "${EXPAND}", "${CONTRACT}", "${CLAIMS}" in that order`,
    );
  }
  for (const [i, l] of lines.entries()) {
    if (
      i !== 0 &&
      i !== contractAt &&
      i !== claimsAt &&
      l.trimStart().startsWith("-- singularity:")
    ) {
      throw new Error(
        `phased migration has a duplicate marker at line ${i + 1}: ${l}`,
      );
    }
  }

  const claims = lines
    .slice(claimsAt + 1)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => {
      if (!l.startsWith("-- ")) {
        throw new Error(
          `phased migration claims section holds a non-claim line: ${l}`,
        );
      }
      const id = l.slice(3).trim();
      assertClaimId(id);
      return id;
    });

  return {
    kind: "phased",
    expand: lines.slice(1, contractAt).join("\n").trim(),
    contract: lines
      .slice(contractAt + 1, claimsAt)
      .join("\n")
      .trim(),
    claims,
    supersedes: null,
    adopts: [],
  };
}
