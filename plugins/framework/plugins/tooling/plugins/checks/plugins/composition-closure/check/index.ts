import type {
  CheckContext,
  WholeTreeRead,
} from "@plugins/framework/plugins/tooling/core";
import {
  buildRegistryGenContext,
  readCompositionManifestsFromDisk,
  codegenPassOver,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import {
  expandEntrySeeds,
  explainInclusion,
  flattenManifest,
  graphForHosts,
  matchEntryPattern,
  removalClosure,
  resolveComposition,
  stepLabel,
} from "@plugins/plugin-meta/plugins/closure/core";
import type { CompositionManifest } from "@plugins/plugin-meta/plugins/closure/core";
import { parseEntryPattern } from "@plugins/plugin-meta/plugins/closure/plugins/entry-pattern/core";
import {
  ALL_EXCLUSIONS_ID,
  MAIN_COMPOSITION_ID,
} from "@plugins/infra/plugins/namespace/core";
import {
  assertCompositionId,
  checkExclusionSets,
  isServed,
  manifestItemToManifest,
  resolveCompositionHome,
  resolveCompositionUnlisted,
} from "@plugins/plugin-meta/plugins/composition/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { companionsVisible } from "./companions-visible";
import { keysDefined } from "./keys-defined";
import { rootMountsReached } from "./root-mounts-reached";
import { pageHostsOnDemand } from "./page-hosts-on-demand";
import { companionsInSync } from "./companions-in-sync";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  run(ctx: CheckContext): Promise<CheckResult>;
  wholeTreeRead?: WholeTreeRead;
};

const fail = (message: string, hint?: string): CheckResult => ({
  ok: false,
  message,
  hint,
});

const check: Check = {
  id: "composition-closure",
  description:
    "Every declared composition is valid: unique name, all entry/contributor ids resolve, the reserved main row and the exclusion sets (`base-exclusions`, `all-exclusions`, every `exclusions` row) are well-formed and every row inherits one, every declared exclusion actually took effect, no negative is dead everywhere, each selected contributor is a genuine load-bearing soft option (no redundant selections), every `excludes` bundle stays disjoint from the composition's hard closure (self-containment guard), and every deployable composition's `home` is an app its bundle holds.",
  async run(ctx) {
    const repo = await ctx.repo();
    const root = repo.root;
    // The barrel-free faceted tree AND its classified edge graph, taken from the
    // shared registry-gen context rather than built here. `buildRegistryGenContext`
    // calls `buildBarrelFreeTree`, which memoizes exactly this
    // `buildFacetedPluginTree(<root>/plugins)`
    // per pass (the run's set), and classifies its edges ONCE for every consumer that takes a ctx.
    // Going through the memo means one 840-plugin faceted walk and one
    // `classifyEdges` pass are shared with every other check in the run instead of
    // a private duplicate of each.
    const registryCtx = await buildRegistryGenContext(codegenPassOver(repo));
    const { tree, graph } = registryCtx;
    const allIds = new Set<PluginId>([...tree.byDir.values()].map((n) => n.id));

    // The committed git-layer `compositions` config, off disk — this check runs in
    // a separate Bun process with NO server runtime, so there is no `getConfig`.
    // The path derivation and the `// @hash` contract live in codegen core, shared
    // with `plugins-registry-in-sync`, so the two checks can never disagree about
    // what the repo declares. Runtime-only (user-layer) manifests are not
    // closure-checked until promoted to the git layer.
    const items = readCompositionManifestsFromDisk(root);
    const manifests = items.map(manifestItemToManifest);

    // 0. Every manifest id is a servable gateway namespace: a serve build uses
    //    the id as one LABEL of the namespace it provisions (and as the whole
    //    namespace from main, where the checkout suffix elides), so the gateway
    //    name rule (charset, ≤63 chars) applies to every id, and the reserved
    //    namespaces (central / main) apply to every id that could be served —
    //    enforced via the canonical helper, never a duplicated regex.
    //
    //    `assertCompositionId`, not `assertServableCompositionNamespace`: main's
    //    own composition is an ORDINARY manifest entry whose id is a reserved
    //    namespace, because it is built by `./equin build` into the main
    //    checkout's namespace rather than provisioned as a composition. The two
    //    questions — "may it be called this?" and "may a namespace be
    //    provisioned for it?" — stopped being the same question here.
    for (const item of items) {
      try {
        assertCompositionId(item.id);
      } catch (err) {
        return fail(
          `composition "${item.name}" has an unusable id "${item.id}": ${err instanceof Error ? err.message : String(err)}`,
          "Composition ids double as gateway namespaces (http://<id>.localhost:9000). Rename the composition.",
        );
      }
    }

    // 0b. Unique ids. Names have always been checked for uniqueness (rule 1), but
    //     ids never were — they were a list-field identity nobody read. They are
    //     now the load-bearing key: the id IS the gateway namespace, the
    //     per-composition registry file segment, the spec dir and the DB name, and
    //     the Studio detail route. Two rows sharing one id means two compositions
    //     writing over each other's namespace, so this must be as hard a rule as
    //     the name one.
    const seenIds = new Set<string>();
    for (const item of items) {
      if (seenIds.has(item.id)) {
        return fail(
          `duplicate composition id "${item.id}"`,
          "Composition ids are namespaces (http://<id>.localhost:9000), registry file segments and DB names — two rows cannot share one. Give the duplicate its own id.",
        );
      }
      seenIds.add(item.id);
    }

    // 0c. The main app is present exactly once. the main composition is an ordinary
    //     manifest entry whose closure is every plugin, and
    //     `plugins-registry-in-sync` proves that closure renders the committed
    //     registries byte-for-byte. Delete the row (or duplicate it) and that
    //     proof silently stops being about main — so the row's existence is
    //     checked here rather than discovered as a confusing "no such
    //     composition" failure in the other check.
    const mainRows = items.filter((i) => i.id === MAIN_COMPOSITION_ID);
    if (mainRows.length !== 1) {
      return fail(
        `expected exactly one composition with id "${MAIN_COMPOSITION_ID}", found ${mainRows.length}`,
        `"${MAIN_COMPOSITION_ID}" is the main app's own composition — the one this repo builds. It must exist (entry points \`["**"]\`, meaning every plugin) so \`plugins-registry-in-sync\` can prove its closure renders the committed registries byte-for-byte. Restore it in plugins/plugin-meta/plugins/composition/core/config.ts.`,
      );
    }

    // 0d. Main never opts into being served. `activatedCompositionIds` already
    //     makes a stored mode INERT (it filters on servability, so main can
    //     never reach the serve stage whatever the config layers say) — this rule
    //     is about the committed seed telling the truth rather than about
    //     preventing an effect. A seed reading anything but `off` would describe a
    //     serve that does not and cannot happen.
    const mainServe = mainRows[0]!.serve;
    if (mainServe !== "off") {
      return fail(
        `composition "${MAIN_COMPOSITION_ID}" has \`serve: "${mainServe}"\``,
        `The main app is built and served by \`./equin build\` into the checkout's own namespace — it is never served as a composition, so any \`serve\` mode on this row would describe something that cannot happen. Set it back to \`"off"\`.`,
      );
    }

    // 0e. The exclusion sets (category `exclusions`): the two reserved ones
    //     exist exactly once, every set is negatives-only, never served, extends
    //     only sets and reaches `base-exclusions`; every other row inherits a
    //     real set, through its `exclusions` field only. The rules and why each
    //     holds: `checkExclusionSets` (plugin-meta/composition/core).
    const sets = checkExclusionSets(items);
    if (sets.kind === "error") return fail(sets.message, sets.hint);
    const setNames = new Set(
      items.filter((i) => i.category === "exclusions").map((i) => i.name),
    );

    // 1. Unique names across all compositions (the config list does not de-dupe).
    const seenNames = new Set<string>();
    for (const m of manifests) {
      if (seenNames.has(m.name)) {
        return fail(
          `duplicate composition name "${m.name}"`,
          "Each manifest in the `compositions` config must declare a unique `name`.",
        );
      }
      seenNames.add(m.name);
    }
    const allNames = seenNames;

    // Did each negative entry pattern trim ANYTHING, anywhere? Keyed by the
    // pattern text, accumulated across every composition, and judged only once
    // every composition has been resolved (rule 3d, below the loop).
    //
    // It cannot be judged per composition any more. Since an exclusion set is
    // folded into every manifest that inherits it, its negatives are evaluated against lean
    // bundles that never reached the excluded plugin in the first place — where
    // trimming nothing is the CORRECT outcome, not a typo. A negative is dead
    // only if it trims nothing in every composition in the repo.
    const negativeTrimmedSomewhere = new Map<string, boolean>();

    for (const m of manifests) {
      // 2. Every id resolves to a real plugin. Entries are now PATTERNS (a
      //    dot-encoded PluginId with an optional leading `!` and trailing `.**`),
      //    so parse each and validate its BASE — for both positive and negative
      //    patterns (a `!X` typo is as wrong as an `X` typo). Contributors carry
      //    no grammar and stay exact-id checks.
      for (const entry of m.entryPoints) {
        const parsed = parseEntryPattern(entry);
        // The root `**` form names no base — it means "every plugin", so there is
        // nothing to resolve. (Its own validity is checked in 3c below.)
        if (parsed.kind === "root") continue;
        if (!allIds.has(parsed.base)) {
          return fail(
            `composition "${m.name}" references unknown plugin id "${parsed.base}" in entry pattern "${entry}"`,
            "Entry points are patterns: a dot-encoded PluginId with an optional leading `!` (trim) and trailing `.**` (subtree), e.g. `apps.website.**` or `!apps.website.demos.**`; or a bare `**` meaning every plugin. The base id must resolve to a real plugin.",
          );
        }
      }
      for (const id of m.selectedContributors) {
        if (!allIds.has(id)) {
          return fail(
            `composition "${m.name}" references unknown plugin id "${id}"`,
            "Ids are dot-encoded PluginIds (e.g. `apps.agent-manager`). Build via `asPluginId(...)` and confirm the plugin exists.",
          );
        }
      }

      // 3. Every `extends` reference resolves to a real composition name.
      for (const ref of m.extends ?? []) {
        if (!allNames.has(ref)) {
          return fail(
            `composition "${m.name}" extends unknown composition "${ref}"`,
            "`extends` lists other composition NAMES (typically packs). Confirm the referenced composition exists.",
          );
        }
      }

      // A composition with NO entry points is a pure contributor SET (a pack):
      // its contributors only become genuine soft options inside an app that
      // `extends` it, so it carries no bundle context to validate standalone.
      // Validity for those ids is enforced where the pack is folded in (below).
      //
      // An exclusion set is judged where it is inherited, the same way: its
      // own bundle is empty, and each negative is measured (3b) in every
      // composition that folds it in.
      if (m.entryPoints.length === 0 || setNames.has(m.name)) continue;

      // Non-pack: validate against the FLATTENED manifest (own + extended packs'
      // entries/contributors unioned), so a profile's `extends` packs are checked
      // in the app's real bundle context.
      const flat = flattenManifest(m, manifests);
      // The negatives this composition writes itself (its own row and its
      // `extends` chain) — its inherited exclusion set's are not, unless the
      // chain writes them too. Naming a plugin the set negates is the
      // documented way to take it back (`expandEntrySeeds`' opt-out), so only
      // an own negative can contradict a named positive (3b-b).
      const ownEntries = new Set(
        flattenManifest(
          m,
          manifests.filter((x) => !setNames.has(x.name)),
        ).entryPoints,
      );

      // 3b. Negative-pattern validity, evaluated on the FLATTENED manifest so a
      //     negative from one composition (its `extends` chain, or its
      //     inherited exclusion set) is judged against the positives unioned in
      //     alongside it. A negative may only trim ids pulled in IMPLICITLY by
      //     some `.**` subtree glob. The two spellings that cannot mean anything
      //     — a negated root, and a negative on a locally named positive — are
      //     refused right here; whether a negative trims anything is measured
      //     here but judged in 3d, once every composition has had its say.
      const parsedEntries = flat.entryPoints.map(parseEntryPattern);
      const positiveSeeds = new Set<PluginId>();
      const namedBases = new Set<PluginId>();
      for (const p of parsedEntries) {
        if (p.negate) continue;
        // A root `**` seeds every id and NAMES none — same rule the engine's
        // `expandEntrySeeds` follows, and it has to be the same here or this check
        // would judge negatives against a seed set the engine never produces.
        // Naming everything would make every negative "contradictory" below.
        if (p.kind === "id") namedBases.add(p.base);
        for (const id of matchEntryPattern(p, graph)) positiveSeeds.add(id);
      }
      // The engine's protected set, verbatim: an id this composition names as an
      // entry positive or selects as a contributor is never trimmed, and naming
      // it suppresses the negative on it entirely (`expandEntrySeeds`).
      const protectedIds = new Set<PluginId>([
        ...namedBases,
        ...flat.selectedContributors,
      ]);
      for (const p of parsedEntries) {
        if (!p.negate) continue;
        // (c) Negated root: `!**` matches every plugin, so it deletes the entire
        //     seed set and leaves an empty bundle. Nothing legitimate is spelled
        //     that way — refuse it here rather than shipping a composition that
        //     builds to nothing.
        if (p.kind === "root") {
          return fail(
            `composition "${m.name}" has a negated root entry "${p.raw}", which would empty the bundle`,
            "`**` means every plugin, so `!**` trims every seed and leaves nothing to build. Remove it — to build a subset, write the positives you want (optionally `**` plus `!<branch>.**` negatives).",
          );
        }
        // (b) Contradictory negative: its base is also an explicit positive entry.
        //     A negative can never cancel a named positive (positives are protected),
        //     so `!X` alongside `X` is a self-cancelling no-op — reject it loudly
        //     rather than silently keeping the positive. Only for a negative the
        //     composition writes itself: one it inherits from its exclusion set
        //     is taken back by naming its base (the website names the report
        //     channel `base-exclusions` keeps out of every other composition).
        if (namedBases.has(p.base) && ownEntries.has(p.raw)) {
          return fail(
            `composition "${m.name}" has a contradictory negative entry "${p.raw}": its base "${p.base}" is also an explicit positive entry`,
            "A negative may only trim ids pulled in implicitly by a `.**` subtree glob — it can never cancel an id named as a positive entry (positives always win). Remove the negative, or remove the conflicting positive.",
          );
        }
        // (a) What this negative actually trims, measured exactly as the engine
        //     measures it — against the CASCADE, not the direct match. `!X`
        //     removes X, X's descendants and everything that transitively imports
        //     X (`removalClosure`), because a surviving importer would drag X
        //     straight back through the hard closure. Counting only the direct
        //     match would call a negative dead whose whole effect is the cascade
        //     — and would also have called the pre-cascade engine's negatives
        //     live when they trimmed a seed that an importer immediately re-added.
        //
        //     The verdict is deferred — see `negativeTrimmedSomewhere`.
        const targets = [...matchEntryPattern(p, graph)].filter(
          (id) => !protectedIds.has(id),
        );
        //
        //     The cascade follows the edges of each host the row declares: a
        //     negative that trims only through a `machine/` import is live on
        //     the desktop and inert in the browser.
        const trims = flat.hosts.some((host) =>
          [
            ...removalClosure(
              targets,
              graphForHosts(graph, [host]),
              protectedIds,
            ),
          ].some((id) => positiveSeeds.has(id)),
        );
        negativeTrimmedSomewhere.set(
          p.raw,
          (negativeTrimmedSomewhere.get(p.raw) ?? false) || trims,
        );
      }

      // 3c–5 hold on EVERY host the row declares, each resolved as that host
      // sees it: a composition for the desktop and the browser must mean what
      // its manifest says in both, and its selections must be genuine options
      // in both bundles.
      for (const host of flat.hosts) {
        const on = flat.hosts.length > 1 ? ` (on the ${host} host)` : "";
        const comp = resolveComposition(graph, flat, host);

        // 3c. Every declared exclusion took effect. A negative removes its targets
        //     and their removal closure from the SEED set, but an id this
        //     composition names explicitly is protected from that removal — so a
        //     protected plugin that IMPORTS an excluded one survives and drags the
        //     excluded plugin back in through the hard closure. When that happens
        //     the composition does not mean what its manifest says, and the engine
        //     reports it as a value rather than resolving the ambiguity by guessing
        //     which of the two the author wanted.
        //
        //     The import chain IS the repair instruction: either the importer named
        //     in it should be excluded too, or the exclusion should be dropped.
        if (comp.unsatisfiedExclusions.length > 0) {
          const lines = comp.unsatisfiedExclusions.map(({ target, path }) => {
            const trail = path.steps
              .map((s) => `${s.from} →(${stepLabel(s)}) ${s.to}`)
              .join("\n        ");
            return `${target} — pulled back in from ${path.origin} (${path.originKind}):\n        ${trail}`;
          });
          return fail(
            `composition "${m.name}"${on} declares ${comp.unsatisfiedExclusions.length} exclusion(s) that did NOT take effect:\n    ${lines.join("\n    ")}`,
            `Each plugin above is excluded (by this composition's own negative, or by the exclusion set it inherits — its \`exclusions\`, "${ALL_EXCLUSIONS_ID}" by default) yet is still in the bundle, because something this composition NAMES imports it — and naming an importer is not a request for what it imports. Either exclude the importer at the head of the chain too, or drop the exclusion. To keep the plugin deliberately, name it here (as an entry positive or a selected contributor): that suppresses the inherited negative outright, and nothing cascades.`,
          );
        }

        // 3e. No negative takes an asked-for plugin it does not name. The
        //     cascade removes every importer of a negated target, and an
        //     importer can be a plugin a positive pattern seeded on purpose:
        //     `!apps.file-explorer.**` took ~20 transcript renderers out of
        //     `conversations.**` in the demo, and nothing said so. The chain
        //     is printed so the author sees what the negative costs.
        if (comp.cascadeLosses.length > 0) {
          const lines = comp.cascadeLosses.map(
            ({ lost, chain }) =>
              `${lost}: ${chain.map((h) => `${h.via === "import" ? "imports" : "child of"} ${h.to}`).join(" → ")}`,
          );
          return fail(
            `composition "${m.name}"${on}: ${comp.cascadeLosses.length} plugin(s) a positive pattern asks for are removed by a negative that does not name them:\n    ${lines.join("\n    ")}`,
            `A negative also removes everything that imports its target. Each plugin above was asked for (by an \`x\` or \`x.**\` entry) and left only because of that cascade. Decide each one: narrow the negative so it stops reaching it; name the plugin as an entry to keep it (the cascade stops at a named plugin; if it still imports the negated one, 3c then fails naming the import); or write it down as its own negative (\`!${comp.cascadeLosses[0]!.lost}\`) to accept losing it.`,
          );
        }

        // 4. No selection already locked in by the entries' hard edges.
        if (comp.redundantSelections.length > 0) {
          return fail(
            `composition "${m.name}"${on} selects already-required contributor(s): ${comp.redundantSelections.join(", ")}`,
            "A contributor pulled in by the entry points' hard closure is included unconditionally — remove it from selectedContributors (or from the extended pack).",
          );
        }

        // 5. Every selected contributor must be a genuine, load-bearing soft option:
        //    deselecting it must remove it from the bundle (i.e. it is in the
        //    `available` frontier of the composition resolved without it). This rejects
        //    selections that are already pulled in via another contributor's hard
        //    closure, and selections that aren't soft contributors at all.
        for (const id of flat.selectedContributors) {
          const without = resolveComposition(
            graph,
            {
              ...flat,
              selectedContributors: flat.selectedContributors.filter(
                (x) => x !== id,
              ),
            },
            host,
          );
          if (!without.available.includes(id)) {
            return fail(
              `composition "${m.name}"${on} selects "${id}", which is not a genuine soft option`,
              "It is either not a soft contributor to this bundle, or it is already pulled in by another selection's hard closure. Remove it from selectedContributors (or from the extended pack).",
            );
          }
        }
      }
    }

    // 3d. Dead negative: a negative entry pattern that trims nothing in ANY
    //     composition — a typo, or a leftover pointing at a plugin that no longer
    //     exists under that id. Judged here, after every composition has been
    //     resolved, because "trims nothing" is only evidence of a mistake when it
    //     holds everywhere: an exclusion set's negatives are inherited by
    //     lean compositions that never reached the excluded plugin, and trimming
    //     nothing there is correct.
    for (const [raw, trimmed] of negativeTrimmedSomewhere) {
      if (trimmed) continue;
      // Which row(s) actually wrote it — the file position to go and edit. A
      // pattern reaches a composition either by being authored on its row or by
      // being folded in (`extends`, or its exclusion set), so the authoring rows are
      // the ones whose own `entryPoints` carry the text.
      const authors = items
        .filter((i) => i.entryPoints.includes(raw))
        .map((i) => i.name);
      return fail(
        `dead negative entry "${raw}" (declared by ${authors.length > 0 ? authors.map((n) => `"${n}"`).join(", ") : "no composition"}) trims no plugin in any composition`,
        `A negative \`!X\` must remove at least one plugin that some composition pulls in implicitly — X itself, a descendant, or something that imports X. This one removes nothing anywhere, so it is a typo or a stale leftover: fix the id, add the \`.**\` positive it was meant to trim, or delete it (plugins/plugin-meta/plugins/composition/core/config.ts).`,
      );
    }

    // 6. `excludes` — the dual of `extends`: each named bundle's CONTAINMENT
    //    (its entries/contributors + their subtrees, NOT their hard deps) must be
    //    DISJOINT from this composition's resolved hard-closure bundle. This is
    //    the self-containment guard: an app excludes `agent-runtime` (and `auth`,
    //    on demand) to assert its release pulls in no agent/worktree/git infra.
    //    Containment (not the excluded bundle's own closure) keeps generic shared
    //    infra usable, while taproots listed as the bundle's entries still catch
    //    transitive contamination — the app's hard closure surfaces any taproot.
    const byName = new Map<string, CompositionManifest>(
      manifests.map((m) => [m.name, m]),
    );

    // A bundle's containment: the territory it DECLARES, not its hard deps.
    // Entry side goes through the SAME pattern grammar the engine seeds with
    // (`expandEntrySeeds`) — each positive's base, plus its subtree only when
    // written `.**`, minus negatives — so containment tracks what the bundle
    // actually ships, never a blind subtree of every entry. Contributor side has
    // no grammar: selecting a contributor ships it + its whole subtree. Shared by
    // the `excludes` disjointness gate and the serve warning below.
    //
    // `expandEntrySeeds` takes the whole flattened MANIFEST, not just its entry
    // points: its negative pass reads `selectedContributors` too, because a
    // locally selected plugin is a positive and positives suppress negatives. A
    // containment therefore also sees the inherited exclusion set's negatives
    // and shrinks by the same cascade — which keeps it agreeing with the engine
    // whose rule it mirrors, and errs permissive (a smaller declared territory)
    // rather than refusing over a plugin the target bundle does not ship.
    const containmentOf = (target: CompositionManifest): Set<PluginId> => {
      const targetFlat = flattenManifest(target, manifests);
      const containment = new Set<PluginId>(
        expandEntrySeeds(targetFlat, graph).seeds,
      );
      for (const id of targetFlat.selectedContributors) {
        containment.add(id);
        for (const descendant of graph.subtree.get(id) ?? [])
          containment.add(descendant);
      }
      return containment;
    };

    for (const item of items) {
      const excludes = item.excludes ?? [];
      if (excludes.length === 0) continue;

      const appFlat = flattenManifest(manifestItemToManifest(item), manifests);
      const appBundle = resolveComposition(graph, appFlat).bundle;

      for (const ref of excludes) {
        // Every `excludes` reference resolves to a real composition name.
        const target = byName.get(ref);
        if (!target) {
          return fail(
            `composition "${item.name}" excludes unknown composition "${ref}"`,
            "`excludes` lists other composition NAMES (the bundles this composition must stay disjoint from, e.g. `agent-runtime`). Confirm the referenced composition exists.",
          );
        }

        const containment = containmentOf(target);
        const offenders = [...appBundle]
          .filter((p) => containment.has(p))
          .sort();
        if (offenders.length > 0) {
          const offender = offenders[0]!;
          const path = explainInclusion(graph, appFlat, offender);
          const trail = path
            ? path.steps
                .map((s) => `${s.from} →(${stepLabel(s)}) ${s.to}`)
                .join("\n    ")
            : "(no path found)";
          return fail(
            `composition "${item.name}" excludes bundle "${ref}" but its closure includes ${offenders.length} plugin(s) from it: ${offenders.join(", ")}`,
            `"${item.name}" declares it must stay disjoint from "${ref}" (self-containment), but "${offender}" is pulled into its bundle. Remove the dependency, or drop "${ref}" from this composition's \`excludes\`. Inclusion path for "${offender}":\n    ${trail}`,
          );
        }
      }
    }

    // 6b. Every composition declares the app that owns bare `/` — its `home` —
    //     and that app is a real `defineApp` whose shell this bundle holds. The
    //     homepage is a property of what is deployed, never of load order: a
    //     stray app reaching the bundle cannot take `/`, and a home that left
    //     the bundle fails here instead of redirecting to whatever registered
    //     first. Same `resolveCompositionHome` verdict registry codegen bakes
    //     into the web registry (and throws on). Required for deployed rows
    //     only (products and served rows); a pack (no entry points) is never
    //     deployed on its own, so it has no home to declare.
    const declaredApps = registryCtx.declaredApps;
    for (const item of items) {
      const homeHint =
        "Set the composition's `home` to the `defineApp` id of the app that owns `/` (plugins/plugin-meta/plugins/composition/core/config.ts, or the Studio compositions pane).";
      if (item.entryPoints.length === 0) {
        if (item.unlisted.length > 0) {
          return fail(
            `composition "${item.name}" has no entry points (a pack) but declares \`unlisted\``,
            "A pack has no launcher of its own — clear its `unlisted`.",
          );
        }
        if (item.home !== "") {
          return fail(
            `composition "${item.name}" has no entry points (a pack) but declares \`home: "${item.home}"\``,
            "A pack is never deployed on its own — clear its `home`.",
          );
        }
        continue;
      }
      const bundle = resolveComposition(
        graph,
        flattenManifest(manifestItemToManifest(item), manifests),
      ).bundle;
      const home = resolveCompositionHome({
        apps: declaredApps,
        bundle,
        home: item.home,
        // The products (app / profile rows) and anything served are deployed;
        // a subsystem is an inspection lens — its home is optional, but checked
        // when set. (Building any composition requires one: codegen passes true.)
        deployed:
          item.category === "app" ||
          item.category === "profile" ||
          isServed(item.serve),
      });
      if (home.kind === "error") {
        return fail(`composition "${item.name}" ${home.message}`, homeHint);
      }
      // Same `resolveCompositionUnlisted` verdict codegen bakes beside `home`.
      const unlisted = resolveCompositionUnlisted({
        apps: declaredApps,
        bundle,
        unlisted: item.unlisted,
        home: item.home,
      });
      if (unlisted.kind === "error") {
        return fail(
          `composition "${item.name}" ${unlisted.message}`,
          "Name in `unlisted` only bundled apps other than the `home` (plugins/plugin-meta/plugins/composition/core/config.ts).",
        );
      }
    }

    // 7. WARNING (never a failure): a served composition that does not exclude
    //    `agent-runtime` may run worktree-assuming plugins under a namespace
    //    that is NOT the checkout's own — unvalidated territory. Which checkout
    //    it runs against is now variable (a serve build publishes
    //    `<composition>.<checkout>`), which makes the mismatch broader rather
    //    than narrower: the plugin's runtime namespace names a namespace with no
    //    git worktree behind it, whichever checkout's tree it is reading.
    //    Declaring the exclude upgrades this to the hard disjointness gate above.
    //
    //    Keyed on `serve` — the declared serve mode — which is the only thing in
    //    the repo that says "this composition is meant to be served", whatever
    //    rate its automatic rebuilds run at. That is exactly the population this
    //    warning is about.
    const agentRuntime = byName.get("agent-runtime");
    if (agentRuntime) {
      const agentRuntimeContainment = containmentOf(agentRuntime);
      for (const item of items) {
        if (!isServed(item.serve)) continue;
        if (item.excludes.includes("agent-runtime")) continue;
        const flat = flattenManifest(manifestItemToManifest(item), manifests);
        const bundle = resolveComposition(graph, flat).bundle;
        const offenders = [...bundle]
          .filter((p) => agentRuntimeContainment.has(p))
          .sort();
        console.warn(
          `[composition-closure] WARNING: served composition "${item.name}" does not exclude "agent-runtime"` +
            (offenders.length > 0
              ? ` and its closure includes ${offenders.length} plugin(s) from it (${offenders.slice(0, 5).join(", ")}${offenders.length > 5 ? ", …" : ""}) — these would run under a namespace that has no git worktree behind it.`
              : ` — add \`excludes: ["agent-runtime"]\` to lock in its self-containment.`),
        );
      }
    }

    return { ok: true };
  },
};

export default [
  check,
  companionsVisible,
  keysDefined,
  rootMountsReached,
  pageHostsOnDemand,
  companionsInSync,
];
