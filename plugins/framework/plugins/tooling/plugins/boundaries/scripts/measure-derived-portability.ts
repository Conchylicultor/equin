/**
 * Measures the server-portability derivation (`core/portability.ts`) over the
 * repo, read-only:
 *
 *   ./equin run plugins/framework/plugins/tooling/plugins/boundaries/scripts/measure-derived-portability.ts
 *
 * Prints the union build's size and time, the derivation's own cost, how many
 * server barrels are portable, and the barrels made non-portable by rule 3
 * alone (a host service no portable `server/` barrel provides), each with its
 * offenders — the barrels that would join a browser host once their service
 * gets a browser provider.
 */
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import { importClosures } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { derivePortability, SERVER_BARREL_RE } from "../core/portability";

const root = await getWorktreeRoot();
const repo = await loadRepoFiles(root);
const barrels = repo
  .all()
  .filter((p) => SERVER_BARREL_RE.test(p))
  .sort();

let t = performance.now();
const closure = await importClosures(root, barrels, { dynamicImports: "cut" });
const buildMs = performance.now() - t;
t = performance.now();
const read = (p: string) => repo.read(p);
const full = await derivePortability({ barrels, closure, read });
const deriveMs = performance.now() - t;
// The same derivation without rule 3: no module declares a host service.
const withoutRule3 = await derivePortability({
  barrels,
  closure,
  read: async (p) =>
    (await repo.read(p))?.replaceAll(
      "defineHostService",
      "defineHostServic_",
    ) ?? null,
});

console.log(
  `server barrels: ${barrels.length}, portable: ${barrels.filter((b) => full.isPortable(b)).length}`,
);
console.log(
  `union closure: ${closure.modules.size} modules, build ${buildMs.toFixed(0)} ms; derivation ${deriveMs.toFixed(0)} ms`,
);
const rule3 = barrels.filter(
  (b) => withoutRule3.isPortable(b) && !full.isPortable(b),
);
console.log(`non-portable by rule 3 alone: ${rule3.length}`);
for (const b of rule3) {
  console.log(`  ${b}`);
  for (const o of full.offenders(b))
    console.log(
      `    ${o.module} (${o.needs.join(", ")})\n      via ${o.chain.join(" → ")}`,
    );
}
