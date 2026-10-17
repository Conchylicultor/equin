// Verifies the options popover draws a prototype's option groups
// (`<meta name="prototype-option-group">`): one foldable section per group,
// named by its label, whose rows drop the group's prefix — and that a folded
// section lists its picks in its header. Reads only; picks nothing.
// Manual only — nothing runs this automatically.
//
// Usage:
//   ./singularity run plugins/apps/plugins/prototypes/plugins/canvas/e2e/canvas-option-groups.ts \
//     [--name <prototype id>] [--out <prefix>] [--headed]

import {
  agentFetch,
  arg,
  report,
  snap,
  usage,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  groupOptions,
  optionLabel,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { openCanvas, openOptions } from "./driver";

const out = arg("out", "/tmp/canvas-option-groups");

/** `--name`, else the first prototype that declares an option group. */
async function pickGroupedPrototype(): Promise<PrototypeMeta> {
  const res = await agentFetch("/api/prototypes");
  if (!res.ok) throw new Error(`GET /api/prototypes → ${res.status}`);
  const rows = (await res.json()) as PrototypeMeta[];
  const wanted = arg("name");
  const meta = wanted
    ? rows.find((p) => p.name === wanted)
    : rows.find((p) => p.options.some((o) => o.group !== null));
  if (!meta) {
    usage(
      wanted
        ? `no prototype "${wanted}" on this deploy`
        : "no prototype on this deploy declares an option group — pass --name",
    );
  }
  return meta;
}

const meta = await pickGroupedPrototype();
const groups = groupOptions(meta.options).filter((g) => g.label !== null);

await withBrowser(async (h) => {
  const r = report(`option groups — ${meta.title} (${meta.name})`);
  const { page } = await h.session({ viewport: { width: 1400, height: 1200 } });
  await openCanvas(page, meta.name);
  const popover = await openOptions(page, "A");
  await snap(page, out, "open");

  for (const group of groups) {
    const header = popover.getByRole("button", {
      name: new RegExp(`^${group.label ?? ""}`),
    });
    r.eq(`a section header for ${group.label ?? ""}`, await header.count(), 1);
    for (const option of group.options) {
      r.ok(
        `${option.name} reads "${optionLabel(option)}"`,
        (await popover
          .getByText(optionLabel(option), { exact: true })
          .count()) > 0,
      );
    }
  }

  const first = groups[0];
  if (first?.label) {
    const header = popover.getByRole("button", {
      name: new RegExp(`^${first.label}`),
    });
    await header.click();
    r.eq(
      `folding ${first.label} reports it closed`,
      await header.getAttribute("aria-expanded"),
      "false",
    );
    await snap(page, out, "folded");
    await header.click();
  }
});
