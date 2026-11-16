import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import { GENERATED_ARTIFACTS } from "@plugins/framework/plugins/tooling/plugins/generated-artifacts/core";

const GITATTRIBUTES = ".gitattributes";
const DRIVERS = new Set<string>(GENERATED_ARTIFACTS.map((a) => a.driver));

/** `<pattern> merge=<driver>` for every `.gitattributes` line naming a regen driver of the list. */
function attributedLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    for (const attr of attrs) {
      const driver = attr.startsWith("merge=") ? attr.slice(6) : null;
      if (driver !== null && DRIVERS.has(driver)) {
        out.push(`${pattern} merge=${driver}`);
      }
    }
  }
  return out;
}

/**
 * `.gitattributes` assigns a regen merge driver to EXACTLY the artifacts
 * `GENERATED_ARTIFACTS` lists, each with the same driver — so the list every
 * reader classifies by (a commit's file kinds, format's held-out set) and the
 * merge contract cannot drift apart.
 */
const check: Check = {
  id: "generated-artifacts-attributed",
  description:
    ".gitattributes regen merge-driver lines and GENERATED_ARTIFACTS (codegen/generated-artifacts) agree",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const repo = await ctx.repo();
    const text = await repo.read(GITATTRIBUTES);
    if (text === null)
      return { ok: false, message: `${GITATTRIBUTES} is missing.` };
    const actual = attributedLines(text);
    const expected = GENERATED_ARTIFACTS.map(
      (a) => `${a.pattern} merge=${a.driver}`,
    );
    const missing = expected.filter((l) => !actual.includes(l));
    const extra = actual.filter((l) => !expected.includes(l));
    if (missing.length === 0 && extra.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${GITATTRIBUTES} and GENERATED_ARTIFACTS (codegen/generated-artifacts/core) disagree.` +
        (missing.length > 0
          ? `\nListed but not attributed in ${GITATTRIBUTES}:\n` +
            missing.map((l) => `  ${l}`).join("\n")
          : "") +
        (extra.length > 0
          ? `\nAttributed in ${GITATTRIBUTES} but not listed:\n` +
            extra.map((l) => `  ${l}`).join("\n")
          : ""),
      hint: "Add the artifact to both: a `.gitattributes` line and a GENERATED_ARTIFACTS entry.",
    };
  },
};

export default check;
