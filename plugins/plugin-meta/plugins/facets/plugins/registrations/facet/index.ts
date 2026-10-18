import {
  createFacet,
  type DocFact,
  type ExtractContext,
} from "@plugins/plugin-meta/plugins/facets/core";
import { type DocMetaRegistration, registrationsFacetDef } from "../core";

function formatRegistration(r: DocMetaRegistration): string {
  const label = r.doc.label;
  if (!r.factory) return `\`${label ?? r.kind}\``;
  return label ? `\`${r.factory}('${label}')\`` : `\`${r.factory}()\``;
}

export default createFacet<DocMetaRegistration[]>({
  def: registrationsFacetDef,

  extract(ctx: ExtractContext): DocMetaRegistration[] {
    const modules = ctx.imported?.modules;
    if (!modules || modules.length === 0) return [];

    const registrations: DocMetaRegistration[] = [];
    for (const { mod, runtime } of modules) {
      if (runtime === "web") continue;
      let def: Record<string, unknown> | undefined;
      try {
        def = mod.default as Record<string, unknown> | undefined;
      } catch (err) {
        if (!(err instanceof TypeError)) throw err;
        continue;
      }
      if (!def) continue;
      const rawRegister = def.register as
        | Array<{
            _kind?: string;
            _factory?: string;
            _doc?: { label?: string; detail?: string };
          }>
        | undefined;
      if (!rawRegister) continue;
      for (const r of rawRegister) {
        if (r._kind) {
          registrations.push({
            kind: r._kind,
            factory: r._factory,
            runtime,
            doc: r._doc ?? {},
          });
        }
      }
    }
    return registrations;
  },

  renderDoc(data: DocMetaRegistration[]) {
    if (data.length === 0) return [];
    const facts: DocFact[] = [];
    for (const runtime of ["server", "machine", "central"] as const) {
      const regs = data.filter((r) => r.runtime === runtime);
      if (regs.length === 0) continue;
      facts.push({
        folder: runtime,
        key: "Register",
        values: regs.map(formatRegistration),
      });
    }
    return facts;
  },
});
