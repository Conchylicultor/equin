// Verifies that every class in the generated ramp table actually STYLES
// something in the deployed app.
//
// The ramp's step→class tables are generated into `core/ramp.generated.ts` from
// app.css, and Tailwind emits an `@utility` only for a literal token its source
// scanner finds. Those two facts meet at the one thing neither the type system
// nor `space-ramp-in-sync` can see: whether the scanner reached the generated
// file's new home. A miss is silent — the class exists in TypeScript, resolves
// to nothing in CSS, and shows up as flattened padding rather than an error.
//
// So this asserts against COMPUTED STYLE in the running app: every family × step
// resolves to a real length, `none` is zero, and the steps increase.
//
// Usage:
//   ./equin run plugins/primitives/plugins/css/plugins/space-ramp/e2e/ramp-verify.ts \
//     [--url http://<worktree>.localhost:9000] [--headed]

import {
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  RAMP_CLASSES,
  SPACE_STEPS,
} from "@plugins/primitives/plugins/css/plugins/space-ramp/core";

const r = report("space-ramp");

// The property each family writes, and which one probe reads back.
//
// `rail-owe` is the exception: it deliberately applies NO padding — it publishes
// the rail for its `rail-follow` descendants to apply — so it is probed through a
// follower child, which is the contract itself. Reading its `--rail-start`
// directly would not work anyway: getComputedStyle returns a custom property's
// substitution text (`var(--space-md)`), not a resolved length.
const PROBE_PROPERTY: Record<keyof typeof RAMP_CLASSES, string> = {
  gap: "gap",
  "gap-x": "column-gap",
  "gap-y": "row-gap",
  p: "padding-top",
  px: "padding-left",
  py: "padding-top",
  pt: "padding-top",
  pr: "padding-right",
  pb: "padding-bottom",
  pl: "padding-left",
  rail: "padding-left",
  "rail-x": "padding-left",
  "rail-y": "padding-top",
  "rail-owe": "padding-left",
};

/** Families probed through a `rail-follow` child rather than on the box itself. */
const PROBED_VIA_FOLLOWER = new Set<keyof typeof RAMP_CLASSES>(["rail-owe"]);

const families = Object.keys(RAMP_CLASSES) as Array<keyof typeof RAMP_CLASSES>;

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(pathUrl("/agents"), { waitUntil: "domcontentloaded" });
  // The ramp lives in the global stylesheet, so any painted app state will do.
  await page.locator("button").first().waitFor({ timeout: 30_000 });

  // The payload crosses into the page as plain serialized data, so it is typed
  // as such — `Object.entries` widens the family key to `string` on the far side.
  const probes = (await page.evaluate(
    ({
      classes,
      property,
      viaFollower,
    }: {
      classes: Record<string, Record<string, string>>;
      property: Record<string, string>;
      viaFollower: string[];
    }) => {
      const host = document.createElement("div");
      host.style.position = "fixed";
      host.style.left = "-9999px";
      host.style.display = "flex";
      document.body.appendChild(host);

      const out: Record<string, Record<string, string>> = {};
      for (const [family, byStep] of Object.entries(classes)) {
        out[family] = {};
        for (const [step, cls] of Object.entries(byStep)) {
          const el = document.createElement("div");
          el.className = cls;
          host.appendChild(el);
          // A publishing-only family owes its rail to a follower, so measure the
          // follower — the box itself is correctly unpadded.
          let probe = el;
          if (viaFollower.includes(family)) {
            probe = document.createElement("div");
            probe.className = "rail-follow";
            el.appendChild(probe);
          }
          out[family]![step] = getComputedStyle(probe)
            .getPropertyValue(property[family]!)
            .trim();
          el.remove();
        }
      }
      host.remove();
      return out;
    },
    {
      classes: RAMP_CLASSES as Record<string, Record<string, string>>,
      property: PROBE_PROPERTY as Record<string, string>,
      viaFollower: [...PROBED_VIA_FOLLOWER] as string[],
    },
  )) as Record<string, Record<string, string>>;

  const px = (v: string): number | null => {
    const m = /^(-?[\d.]+)px$/.exec(v);
    return m ? Number(m[1]) : null;
  };

  for (const family of families) {
    const byStep = probes[family]!;

    // 1. Every class resolves to a real length — the scanner-reach assertion.
    for (const step of SPACE_STEPS) {
      const value = byStep[step]!;
      r.ok(
        `${RAMP_CLASSES[family][step]} applies a length`,
        px(value) !== null,
        `computed ${PROBE_PROPERTY[family]} = ${JSON.stringify(value)} — the class ` +
          `is in the generated table but the stylesheet has no rule for it, so ` +
          `Tailwind's scanner did not reach core/ramp.generated.ts`,
      );
    }

    // 2. `none` is the constant zero step.
    r.eq(`${family}-none is 0`, px(byStep.none!), 0);

    // 3. The steps are a RAMP: each one strictly larger than the last. Catches a
    //    family wired to the wrong token even when every class exists.
    const sized = SPACE_STEPS.map((s) => ({ step: s, value: px(byStep[s]!) }));
    for (let i = 1; i < sized.length; i++) {
      const prev = sized[i - 1]!;
      const curr = sized[i]!;
      if (prev.value === null || curr.value === null) continue;
      r.ok(
        `${family}: ${curr.step} > ${prev.step}`,
        curr.value > prev.value,
        `${curr.step}=${curr.value}px is not larger than ${prev.step}=${prev.value}px`,
      );
    }
  }

  r.note(
    `probed ${families.length} families × ${SPACE_STEPS.length} steps = ` +
      `${families.length * SPACE_STEPS.length} classes at ${pathUrl("/agents")}`,
  );
});

await r.finish();
