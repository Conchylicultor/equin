import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import type {
  Move,
  Outdated,
  Updater,
} from "@plugins/infra/plugins/deps/plugins/updates/core";
import {
  installedVersions,
  planNpm,
  rangeAt,
  readWorkspace,
  utcDay,
  workspaceManifests,
  type Packument,
  type Plan,
  type Workspace,
} from "@plugins/infra/plugins/deps/plugins/npm/core";

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a release must have been public before the updater adopts it — the
 * same cooldown as the uv updater, and the cheapest defence against a hijacked
 * fresh release.
 */
export const NPM_COOLDOWN_DAYS = 3;

/** Packuments fetched at once: a weekly pass over ~200 packages. */
const CONCURRENCY = 8;

const PackumentSchema = z.object({
  "dist-tags": z.object({ latest: z.string() }).passthrough(),
  time: z.record(z.string()),
});

async function fetchPackument(name: string): Promise<Packument> {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(MINUTE) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  const doc = PackumentSchema.parse(await res.json());
  const published = new Map(
    Object.entries(doc.time).filter(
      ([v]) => v !== "created" && v !== "modified",
    ),
  );
  return { latest: doc["dist-tags"].latest, published };
}

async function fetchAll(
  names: readonly string[],
): Promise<Map<string, Packument>> {
  const out = new Map<string, Packument>();
  const queue = [...names];
  const worker = async (): Promise<void> => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      out.set(name, await fetchPackument(name));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

async function planNow(root: string): Promise<{ plan: Plan; ws: Workspace }> {
  const ws = await readWorkspace(root);
  if (ws.policyErrors.length > 0) {
    throw new Error(
      `dependencyPolicy does not parse (\`./singularity check deps-npm:policy\`):\n  ${ws.policyErrors.map((e) => `${e.manifest}: ${e.message}`).join("\n  ")}`,
    );
  }
  const installed = installedVersions(ws);
  const now = new Date();
  const plan = planNpm({
    installed,
    packuments: await fetchAll(installed.map((i) => i.name)),
    groups: ws.policies.flatMap((p) => p.policy.groups ?? []),
    holds: ws.policies.flatMap((p) => p.policy.holds ?? []),
    patched: ws.lock.patched,
    cutoff: new Date(now.getTime() - NPM_COOLDOWN_DAYS * DAY_MS).toISOString(),
    today: utcDay(now),
  });
  return { plan, ws };
}

/** Rewrite one dependency's spec in every package.json that declares it. */
function rewriteSpecs(
  root: string,
  ws: Workspace,
  name: string,
  spec: (old: Workspace["declared"][number]) => string,
): void {
  for (const d of ws.declared.filter((x) => x.name === name)) {
    const path = join(root, d.manifest);
    const text = readFileSync(path, "utf8");
    const from = `${JSON.stringify(d.name)}: ${JSON.stringify(d.raw)}`;
    if (!text.includes(from))
      throw new Error(`${d.manifest}: cannot find ${from} to rewrite.`);
    writeFileSync(
      path,
      text.replaceAll(
        from,
        `${JSON.stringify(d.name)}: ${JSON.stringify(spec(d))}`,
      ),
    );
  }
}

async function bunInstall(
  root: string,
  log: (line: string) => void,
): Promise<void> {
  log("  bun install");
  const result = await spawnCaptured(["bun", "install"], {
    cwd: root,
    timeoutMs: 20 * MINUTE,
    mergeStderr: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `bun install failed (exit ${result.exitCode}):\n${result.stdout.trim().split("\n").slice(-30).join("\n")}`,
    );
  }
}

async function regenGenerated(
  root: string,
  log: (line: string) => void,
): Promise<void> {
  log("  ./singularity regen-generated");
  const regen = await spawnCaptured(
    [join(root, "singularity"), "regen-generated"],
    {
      cwd: root,
      timeoutMs: 20 * MINUTE,
      mergeStderr: true,
    },
  );
  if (regen.exitCode !== 0)
    throw new Error(
      `regen-generated failed (exit ${regen.exitCode}):\n${regen.stdout.trim().split("\n").slice(-30).join("\n")}`,
    );
}

/**
 * Every directly declared npm package, across every workspace package.json, as
 * one updater: `bun.lock` and the specs that name each release. Moves to the
 * newest release past a 3-day cooldown and the holds, a lockstep group as one,
 * a new major by rewriting its range. Declarations (groups, holds) are the
 * `dependencyPolicy` of the package.json that owns the dependency.
 */
export const npmUpdater: Updater = {
  id: "npm",
  description:
    "Every npm package a workspace package.json declares: its range and bun.lock, moved to the newest release past a 3-day cooldown, lockstep groups together",
  files: async (root) => [...(await workspaceManifests(root)), "bun.lock"],

  async detect(root): Promise<Outdated[]> {
    return (await planNow(root)).plan.outdated;
  },

  async plan(root, only): Promise<Move[]> {
    const { plan, ws } = await planNow(root);
    if (only === undefined) return plan.moves;
    const known = new Set(ws.declared.map((d) => d.name));
    const unknown = only.filter((n) => !known.has(n));
    if (unknown.length > 0)
      throw new Error(
        `Unknown npm package ${unknown.join(", ")}: no package.json declares it.`,
      );
    // A lockstep group moves whole or not at all: naming one member names it.
    const groups = ws.policies.flatMap((p) => p.policy.groups ?? []);
    const named = new Set(only);
    for (const g of groups)
      if (g.members.some((m) => named.has(m)))
        for (const m of g.members) named.add(m);
    return plan.moves.filter((m) => named.has(m.name));
  },

  // Two installs, so the lock lands on exactly the planned release: the exact
  // spec makes bun resolve `to` itself, then widening it back to a range keeps
  // that locked version (bun re-resolves only a spec its lock no longer
  // satisfies). One install of `^to` would take whatever is newest at that
  // moment, cooldown or not.
  async apply(root, moves, log) {
    const ws = await readWorkspace(root);
    for (const { name, to } of moves) rewriteSpecs(root, ws, name, () => to);
    await bunInstall(root, log);
    const pinned = await readWorkspace(root);
    for (const { name, to } of moves) {
      const original = new Map(
        ws.declared.filter((d) => d.name === name).map((d) => [d.manifest, d]),
      );
      rewriteSpecs(root, pinned, name, (d) => {
        const spec = original.get(d.manifest)?.spec;
        return spec?.kind === "range" ? rangeAt(spec, to) : `^${to}`;
      });
    }
    await bunInstall(root, log);
    const after = await readWorkspace(root);
    for (const { name, to } of moves) {
      for (const d of after.declared.filter((x) => x.name === name)) {
        const got = after.lock.resolved(d.workspace, name);
        if (got !== to)
          throw new Error(
            `bun.lock resolved ${name} for ${d.manifest} to ${got ?? "nothing"}, not ${to}.`,
          );
      }
    }
    // Generated artifacts formatted or derived through a moved package (prettier)
    // are regenerated, so the candidate's in-sync checks compare like with like.
    await regenGenerated(root, log);
  },

  // The manifests and bun.lock are back: reinstall from them, and regenerate
  // what `apply` regenerated through the candidate packages.
  async sync(root, log) {
    await bunInstall(root, log);
    await regenGenerated(root, log);
  },

  smoke: async () => [],

  holds: {
    file: "package.json (the `dependencyPolicy.holds` of the package.json that declares the dependency)",
  },
};
