import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  asFsPath,
  machineNode,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  DATA_ENTRY,
  listEntryJson,
} from "@plugins/framework/plugins/server-core/core";
import { sourceFilesIn } from "@plugins/plugin-meta/plugins/parse-utils/plugins/source-files/core";
import {
  createSourceAnalysis,
  formatUnreadable,
  readRepoCompilerOptions,
  type SourceAnalysis,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/source-analysis/core";
import ts from "typescript";
import {
  factJson,
  type WebListDeclaration,
} from "@plugins/framework/plugins/list-catalog/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { sharedMemo } from "@plugins/packages/plugins/shared-work/core";
import {
  evaluateAllBarrels,
  recordAllWebSlotNaming,
  recordSlotNaming,
  type BarrelEvaluation,
} from "./evaluated-barrels";
import { scanFiles } from "./file-scans";
import { JOB_READS_SCAN } from "./job-reads.scan";
import { writeGenerated } from "./write-generated";
import type { CodegenPass } from "./codegen-pass";

/**
 * The list catalog: what the build knows about every contributed list, web
 * and server, from the records it keeps of every plugin barrel (no barrel
 * imported when nothing changed). ONE collector per runtime, ONE rule for
 * what an entry's data is, ONE in-sync check (`list-catalog-in-sync`).
 *
 * ## Web lists (written between the web and the server import phases)
 *
 * - **The declared web lists** (`list-catalog/plugins/web-lists/core/web-lists.generated.ts`):
 *   every slot any web plugin of the repo declares — id, declaring plugin,
 *   key, `meta`, and whether the main composition declares it (`inMain`). A server barrel reads it at load (reorder registers
 *   a config directive per reorderable list), so it is a post-web manifest:
 *   written after the web barrels evaluated, before any server barrel.
 * - **Every web list's entries** (`server-core/core/web-list-entries.generated.json`):
 *   each contribution of every web plugin of the repo as its FACT
 *   (`list-catalog`'s `factOf`: plain data, a code marker where a field is
 *   code), with its list and plugin. An entry with a value that is neither
 *   data nor code FAILS here, naming the list, the plugin and where — never
 *   written wrong. Loaded at boot by the server (`installWebListEntries`) and
 *   shipped to the page, kept to its composition (web-artifacts' composition
 *   module), so a reader of a web list's facts starts no plugin.
 *
 * A list whose slot is declared `catalog: { omitted }` (settings, which
 * have their own declared form) is left out, as a whole and on purpose.
 *
 * ## Server lists (written after every barrel evaluated)
 *
 * Generates what the build knows about the server's contributed lists, from
 * the records it keeps of every plugin barrel (no barrel imported when nothing
 * changed), as three committed files:
 *
 * - **Who contributes to which list** (`server-core/core/contributors.generated.ts`):
 *   every server contribution kind (its debug name) → the graph nodes whose
 *   barrels contribute to it (`<pluginPath>` for a `server/` half,
 *   `<pluginPath>#machine` for a `machine/` half), and every sink
 *   (`sink:<id>`) → its handlers. A process that started only some plugins
 *   (a job, server-core's `resolveStartSet`) starts the contributors of the
 *   lists its work reads, and the list rule guards every other complete list.
 * - **The entries of every data list** (`server-core/core/list-entries.generated.ts`):
 *   a kind defined `data: true` is read from this file on every host, so
 *   reading it starts nobody. An entry that is not plain data FAILS here,
 *   naming the list, the plugin and where — it is never written wrong.
 * - **The lists each supervised job reads** (`supervised-job/cli/job-reads.generated.ts`):
 *   derived from the `read(List)` calls of each `defineSupervisedJob` run body
 *   (`job-reads.scan.ts`, fail-closed), each list resolved to its debug name
 *   through the record of the barrel it is imported from. A job's child starts
 *   the contributors of exactly these — nothing is declared by hand.
 *
 * None is imported by a barrel — each is loaded dynamically (a boot, a job's
 * child) — so rewriting one re-keys no plugin record. The
 * `list-catalog-in-sync` check fails on drift of any of them.
 */

const CONTRIBUTORS_REL_PATH =
  "plugins/framework/plugins/server-core/core/contributors.generated.ts";
const LIST_ENTRIES_REL_PATH =
  "plugins/framework/plugins/server-core/core/list-entries.generated.ts";
const JOB_READS_REL_PATH =
  "plugins/infra/plugins/jobs/plugins/supervised-job/cli/job-reads.generated.ts";

const WEB_LISTS_REL_PATH =
  "plugins/framework/plugins/list-catalog/plugins/web-lists/core/web-lists.generated.ts";
const WEB_LIST_ENTRIES_REL_PATH =
  "plugins/framework/plugins/server-core/core/web-list-entries.generated.json";

const GEN_BY =
  "// (see plugins/framework/plugins/tooling/plugins/codegen/core/list-catalog-gen.ts).";

const CONTRIBUTORS_HEADER = [
  "// DO NOT EDIT — autogenerated by `./equin build`",
  GEN_BY,
  "//",
  "// Every server contribution kind (its debug name) → the graph nodes that",
  "// contribute to it (`<pluginPath>`, `<pluginPath>#machine`), and every",
  "// sink (`sink:<id>`) → the nodes handling it (`sinkHandlers`). Read by a",
  "// process that starts only some plugins (server-core's `resolveStartSet`",
  "// and the list rule). The `list-catalog-in-sync` check fails on drift.",
].join("\n");

const LIST_ENTRIES_HEADER = [
  "// DO NOT EDIT — autogenerated by `./equin build`",
  GEN_BY,
  "//",
  "// The entries of every server list defined `data: true`",
  "// (`defineServerContribution`): debug name → the graph node that",
  "// contributed each entry and the entry, as plain data. Every host reads",
  "// such a list from here (`installListEntries`, at boot), so reading it",
  "// starts no contributor. The `list-catalog-in-sync` check fails on",
  "// drift; every boot compares it with what its started plugins declare.",
].join("\n");

const JOB_READS_HEADER = [
  "// DO NOT EDIT — autogenerated by `./equin build`",
  GEN_BY,
  "//",
  "// Every supervised job with a `run` body → the contributed lists (debug",
  "// names) its body reads with `read(List)`, derived from the body's own",
  "// calls. A job's child starts the contributors of exactly these",
  "// (`./equin supervised-exec`). The `list-catalog-in-sync` check fails",
  "// on drift.",
].join("\n");

const SERVER_HALVES = ["server", "machine"] as const;

/** A sink's handlers' key in the table (server-core's start set reads it). */
const SINK_KEY = "sink:";

type RawContribution = { _kind?: unknown; [key: string]: unknown };

interface ServerLists {
  contributors: Record<string, string[]>;
  /** Data list → its entries, each as canonical JSON. */
  entries: Record<string, { node: string; json: string }[]>;
  jobReads: Record<string, string[]>;
}

/** `path` relative to the checkout root (no `node:path` in `core/`). */
function repoRel(root: string, path: string): string {
  if (!path.startsWith(`${root}/`))
    throw new Error(
      `[server-lists] ${path} is not inside the checkout ${root}`,
    );
  return path.slice(root.length + 1);
}

function addTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  let list = map.get(key);
  if (list === undefined) map.set(key, (list = []));
  list.push(value);
}

/** A data contribution's own entry: what its readers get. */
function entryOf(c: RawContribution): Record<string, unknown> {
  const {
    _kind: _k,
    _doc: _d,
    _pluginId: _p,
    _pluginDescription: _pd,
    [DATA_ENTRY]: _data,
    ...entry
  } = c;
  return entry;
}

/** One data entry as canonical JSON, or a throw naming the list and the plugin. */
function dataEntryJson(
  entry: Record<string, unknown>,
  kind: string,
  node: string,
): string {
  try {
    return listEntryJson(entry, `"${kind}" entry of ${node}`);
  } catch (err) {
    // A value the record could not keep (a zod schema, a React element)
    // throws on read with the record's own words: say which entry it is.
    throw new Error(
      `[server-lists] "${kind}" entry of ${node} cannot be written down as data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function collectServerLists(pass: CodegenPass): Promise<ServerLists> {
  const ev = await evaluateAllBarrels(pass);
  const contributors = new Map<string, Set<string>>();
  const entries = new Map<string, { node: string; json: string }[]>();
  for (const node of ev.tree.byDir.values()) {
    const path = asFsPath(node.id);
    for (const { mod, runtime } of ev.modulesOf(node)) {
      if (!(SERVER_HALVES as readonly string[]).includes(runtime)) continue;
      const graphNode = runtime === "machine" ? machineNode(path) : path;
      const def = mod.default as
        | {
            contributions?: readonly RawContribution[];
            sinkHandlers?: readonly { sinkId?: unknown }[];
          }
        | undefined;
      const contributeTo = (key: string): void => {
        let nodes = contributors.get(key);
        if (nodes === undefined) contributors.set(key, (nodes = new Set()));
        nodes.add(graphNode);
      };
      // A plugin handling a sink (`sinkHandlers`): recorded as `sink:<id>`,
      // so a process whose modules declare the sink starts its handler.
      for (const h of def?.sinkHandlers ?? []) {
        if (typeof h.sinkId !== "string") {
          throw new Error(
            `[server-contributors] ${graphNode}: a sinkHandlers entry has no sinkId — is it \`sinkHandler(sink, …)\`?`,
          );
        }
        contributeTo(`${SINK_KEY}${h.sinkId}`);
      }
      for (const c of def?.contributions ?? []) {
        const kind = c._kind;
        if (typeof kind !== "symbol" || kind.description === undefined) {
          throw new Error(
            `[server-contributors] ${graphNode}: a contribution has no kind symbol — is it a \`defineServerContribution\` token's call?`,
          );
        }
        contributeTo(kind.description);
        if (c[DATA_ENTRY] === true)
          addTo(entries, kind.description, {
            node: graphNode,
            json: dataEntryJson(entryOf(c), kind.description, graphNode),
          });
      }
    }
  }
  return {
    contributors: Object.fromEntries(
      [...contributors]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, nodes]) => [kind, [...nodes].sort()]),
    ),
    entries: Object.fromEntries(
      [...entries]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, list]) => [
          kind,
          // By node, then each node's own declaration order (a stable sort).
          [...list].sort((a, b) => a.node.localeCompare(b.node)),
        ]),
    ),
    jobReads: await collectJobReads(pass, ev),
  };
}

/**
 * Every supervised job's `read(List)` lists, by job name: each file of every
 * plugin scanned (`JOB_READS_SCAN`, a file record: only a changed file is
 * read), each read's import followed through its barrel's re-exports to the
 * `const` declaring it (the shared source analysis), whose initializer must be
 * `defineServerContribution("<debug name>", …)`. A read whose list resolves to
 * anything else, or a job name defined twice, fails the build.
 */
async function collectJobReads(
  pass: CodegenPass,
  ev: BarrelEvaluation,
): Promise<Record<string, string[]>> {
  const repo = ev.tree.repo;
  const files: string[] = [];
  for (const node of ev.tree.byDir.values()) {
    for (const file of sourceFilesIn(repo, node.dir)) {
      if (file.endsWith(".generated.ts")) continue;
      files.push(repoRel(pass.root, file));
    }
  }
  const scanned = await scanFiles(repo, files, JOB_READS_SCAN);
  const out = new Map<string, string[]>();
  const where = new Map<string, string>();
  // Built only when some job reads a list: most builds read none of it.
  let analysis: SourceAnalysis | null = null;
  const sources = {
    has: (rel: string) => repo.has(rel),
    read: (rel: string) => repo.read(rel),
  };
  for (const [i, jobs] of scanned.entries()) {
    const file = files[i]!;
    for (const { job, reads } of jobs) {
      const earlier = where.get(job);
      if (earlier !== undefined)
        throw new Error(
          `[job-reads] supervised job "${job}" is defined twice (${earlier} and ${file}): a job's name is its identity.`,
        );
      where.set(job, file);
      const kinds: string[] = [];
      for (const r of reads) {
        analysis ??= createSourceAnalysis({
          ts,
          files: sources,
          parse: ({ rel, src }) =>
            Promise.resolve(
              ts.createSourceFile(
                rel,
                src,
                ts.ScriptTarget.Latest,
                true,
                ts.ScriptKind.TS,
              ),
            ),
          compilerOptions: await readRepoCompilerOptions(ts, sources),
        });
        kinds.push(await listDebugName(analysis, file, job, r));
      }
      out.set(job, [...new Set(kinds)].sort());
    }
  }
  return Object.fromEntries([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/** The debug name of the list one `read(List)` names, followed to its declaration. */
async function listDebugName(
  analysis: SourceAnalysis,
  file: string,
  job: string,
  read: { specifier: string; exported: string; site: string },
): Promise<string> {
  const fail = (why: string): never => {
    throw new Error(
      `[job-reads] ${read.site}: job "${job}" reads \`${read.exported}\` from "${read.specifier}", ${why} ` +
        'A job\'s `read` takes a contributed list — a `const` bound to `defineServerContribution("<name>", …)` — imported by name.',
    );
  };
  const mod = analysis.resolveModule(file, read.specifier);
  if (mod.kind !== "repo") return fail("which is not a module of the repo.");
  const binding = await analysis.exportedBinding(mod.rel, read.exported);
  if (binding.kind === "unreadable")
    return fail(
      `whose declaration cannot be read: ${formatUnreadable(binding.unreadable)}.`,
    );
  if (binding.value.kind !== "declaration")
    return fail("which is not a declaration of the repo.");
  const init = analysis.initializerOf(binding.value.declaration);
  if (init.kind === "unreadable")
    return fail(
      `whose value cannot be read: ${formatUnreadable(init.unreadable)}.`,
    );
  let e = init.value;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e)
  )
    e = e.expression;
  if (
    !ts.isCallExpression(e) ||
    !ts.isIdentifier(e.expression) ||
    e.expression.text !== "defineServerContribution"
  )
    return fail("which is not bound to a `defineServerContribution(…)` call.");
  const name = e.arguments[0];
  if (
    name === undefined ||
    !(ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
  )
    return fail("whose list is not named by a string literal.");
  return name.text;
}

/** Path to the committed contributor table. */
export function serverContributorsPath(root: AppPath): AppPath {
  return joinAppPath(root, CONTRIBUTORS_REL_PATH);
}

/** The three files, in memory (the in-sync check renders them too). */
export async function renderServerContributors(
  pass: CodegenPass,
): Promise<{ file: AppPath; content: string }[]> {
  const lists = await collectServerLists(pass);
  const contributorLines = Object.entries(lists.contributors).map(
    ([kind, nodes]) => `  ${JSON.stringify(kind)}: ${JSON.stringify(nodes)},`,
  );
  const entryLines = Object.entries(lists.entries).flatMap(([kind, list]) => [
    `  ${JSON.stringify(kind)}: [`,
    ...list.map(
      (e) => `    { node: ${JSON.stringify(e.node)}, entry: ${e.json} },`,
    ),
    "  ],",
  ]);
  const jobLines = Object.entries(lists.jobReads).map(
    ([job, kinds]) => `  ${JSON.stringify(job)}: ${JSON.stringify(kinds)},`,
  );
  return [
    {
      file: serverContributorsPath(pass.root),
      content: [
        CONTRIBUTORS_HEADER,
        "",
        "export const serverContributors: Readonly<Record<string, readonly string[]>> = {",
        ...contributorLines,
        "};",
        "",
      ].join("\n"),
    },
    {
      file: joinAppPath(pass.root, LIST_ENTRIES_REL_PATH),
      content: [
        LIST_ENTRIES_HEADER,
        "",
        "export const serverListEntries: Readonly<",
        "  Record<string, readonly { readonly node: string; readonly entry: unknown }[]>",
        "> = {",
        ...entryLines,
        "};",
        "",
      ].join("\n"),
    },
    {
      file: joinAppPath(pass.root, JOB_READS_REL_PATH),
      content: [
        JOB_READS_HEADER,
        "",
        "export const jobReads: Readonly<Record<string, readonly string[]>> = {",
        ...jobLines,
        "};",
        "",
      ].join("\n"),
    },
  ];
}

/** Write each file whose bytes changed. */
export async function generateServerContributors({
  pass,
}: {
  pass: CodegenPass;
}): Promise<void> {
  for (const f of await renderServerContributors(pass)) await writeGenerated(f);
  // The web entries need the full evaluation too (the declaration pass): no
  // barrel loads the file, so it is written here, with the server lists.
  await writeGenerated({
    file: webListEntriesPath(pass.root),
    content: await renderWebListEntries(pass),
  });
}

// ── Web lists ────────────────────────────────────────────────────────────────

const WEB_LISTS_HEADER = [
  "// DO NOT EDIT — autogenerated by `./equin build`",
  GEN_BY,
  "//",
  "// Every web list any web plugin of the repo declares (its slots): id,",
  "// declaring plugin, key and `meta`, as the slot stamped it, and whether",
  "// the main composition declares it. Read by the server, which cannot see",
  "// web slots (reorder registers a config directive per reorderable list of",
  "// main), and shipped to each page kept to its composition. The",
  "// `list-catalog-in-sync` check fails on drift.",
].join("\n");

type WebContribution = Record<string, unknown> & { _slot?: SlotHandle };

/**
 * Every declared web list of the repo — over every web barrel, whatever
 * composition bundles it — each saying whether the main composition declares
 * it. Read off the web evaluation alone (a server barrel reads the file at
 * load), between the web and the server import phases.
 */
const collectWebLists: (
  pass: CodegenPass,
) => Promise<{ lists: WebListDeclaration[]; omitted: ReadonlySet<string> }> =
  sharedMemo(
    "web list catalog: lists",
    async (pass) => {
      const naming = await recordAllWebSlotNaming(pass);
      const main = new Set(
        (await recordSlotNaming(pass, "registry"))
          .declarations()
          .map((d) => d.id),
      );
      const omitted = new Set<string>();
      const lists: WebListDeclaration[] = [];
      for (const d of naming.declarations()) {
        // A list left out of the catalog is still a declared list (reorder
        // reads the set): only its entries are not written.
        if (d.slot.meta.catalog !== undefined) omitted.add(d.id);
        lists.push({
          id: d.id,
          plugin: d.pluginId,
          key: d.key,
          meta: d.slot.meta,
          inMain: main.has(d.id),
        });
      }
      lists.sort((a, b) => a.id.localeCompare(b.id));
      return { lists, omitted };
    },
    { owner: (pass) => pass.repo },
  );

/**
 * Every entry of every web list of the repo, as its fact: every web barrel as
 * the FULL evaluation holds it — after the declaration pass, so a plugin that
 * fills its contributions from the declared lists (the pane plugin's title
 * item per header slot) has its entries, as on the page. Its slots are named
 * by the source-scope naming of that same evaluation; an entry whose list is
 * not a declared web list fails the build.
 */
const collectWebEntries: (
  pass: CodegenPass,
) => Promise<{ list: string; plugin: string; json: string }[]> = sharedMemo(
  "web list catalog: entries",
  async (pass) => {
    const ev = await evaluateAllBarrels(pass);
    const naming = await recordSlotNaming(pass, "source");
    const { lists, omitted } = await collectWebLists(pass);
    const listed = new Set(lists.map((l) => l.id));
    const entries: { list: string; plugin: string; json: string }[] = [];
    for (const node of ev.tree.byDir.values()) {
      for (const { mod, runtime } of ev.modulesOf(node)) {
        if (runtime !== "web") continue;
        const def = mod.default as
          { contributions?: readonly WebContribution[] } | undefined;
        for (const c of def?.contributions ?? []) {
          if (c._slot === undefined) continue;
          const lookup = naming.idOf(c._slot);
          if (lookup.kind !== "named" || !listed.has(lookup.id)) {
            throw new Error(
              `[list-catalog] ${node.id} contributes to ${lookup.kind === "named" ? `"${lookup.id}", which no web plugin declares` : "a web list no plugin declares"} — its entry has no list to be written under.`,
            );
          }
          if (omitted.has(lookup.id)) continue;
          let json: string;
          try {
            json = factJson(c, "entry");
          } catch (err) {
            throw new Error(
              `[list-catalog] the "${lookup.id}" entry of ${node.id} cannot be written down as a fact: ${err instanceof Error ? err.message : String(err)}. ` +
                "An entry's fact is what the build sees of it: plain data, or code (a function, a component, an element, a class instance). " +
                "A value that is neither cannot be shipped as data — make it data, or code.",
              { cause: err },
            );
          }
          entries.push({ list: lookup.id, plugin: node.id, json });
        }
      }
    }
    // By list, then plugin; each plugin's own declaration order kept (a
    // stable sort) — a reader of a list reads it in registry order anyway.
    entries.sort(
      (a, b) =>
        a.list.localeCompare(b.list) || a.plugin.localeCompare(b.plugin),
    );
    return entries;
  },
  { owner: (pass) => pass.repo },
);

/** Path to the committed declared-web-lists file. */
export function webListsPath(root: AppPath): AppPath {
  return joinAppPath(root, WEB_LISTS_REL_PATH);
}

/** Path to the committed web-list entries file. */
export function webListEntriesPath(root: AppPath): AppPath {
  return joinAppPath(root, WEB_LIST_ENTRIES_REL_PATH);
}

/** The declared web lists file, in memory. */
export async function renderWebLists(pass: CodegenPass): Promise<string> {
  const { lists } = await collectWebLists(pass);
  return [
    WEB_LISTS_HEADER,
    "",
    'import type { WebListDeclaration } from "@plugins/framework/plugins/list-catalog/core";',
    "",
    "export const webLists: readonly WebListDeclaration[] = [",
    ...lists.map((l) => `  ${JSON.stringify(l)},`),
    "];",
    "",
  ].join("\n");
}

/**
 * The web list entries file, in memory: JSON, one entry a line. Data, not
 * code — so no check reading source text judges a copied value (a CSS var, a
 * path in a prompt) as if this file had written it; the plugin that did is
 * checked in its own source. Loaded at boot by the server
 * (`installWebListEntries`) and by web-artifacts' page catalog.
 */
export async function renderWebListEntries(pass: CodegenPass): Promise<string> {
  const entries = await collectWebEntries(pass);
  return [
    "[",
    entries
      .map(
        (x) =>
          `  {"list":${JSON.stringify(x.list)},"plugin":${JSON.stringify(x.plugin)},"fact":${x.json}}`,
      )
      .join(",\n"),
    "]",
    "",
  ].join("\n");
}
