import { lineAt, markerCallSpans } from "./find-marker-calls";
import { matchBracket, readStaticCallId } from "./helpers";
import { maskSource } from "./mask-source";

/**
 * One `defineServerContribution("<kind>", { … })` declaration: the contribution
 * kind its tokens stamp (`_kind.description`), the name the token is bound to,
 * and the two options a static reader acts on.
 */
export interface ServerContributionKindDecl {
  kind: string;
  /** The `const` the token is bound to (`export const X = defineServerContribution(…)`), when it is. */
  binding?: string;
  /** Declares `absentOnHost` — a host may run without some of its contributors. */
  absentOnHost: boolean;
  /** Opened to companions (`companions: true`): a `companion: true` contribution ships with its declarer. */
  companions: boolean;
}

/** `const <Name> = ` (optionally exported) immediately before the call. */
const BINDING_RE = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*$/;

/**
 * The offset of the value of a depth-1 `<field>:` in the object literal
 * starting at `brace` (masked), or undefined when the object has no such field.
 */
function topLevelFieldAt(
  masked: string,
  brace: number,
  field: string,
): number | undefined {
  const end = matchBracket(masked, brace, "{", "}");
  if (end < 0) return undefined;
  const re = new RegExp(`^${field}\\s*:\\s*`);
  let depth = 0;
  for (let i = brace; i < end; i++) {
    const c = masked[i]!;
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    if (depth !== 1) continue;
    if (i > brace && /[\w$]/.test(masked[i - 1]!)) continue;
    const m = re.exec(masked.slice(i, end));
    if (m) return i + m[0].length;
  }
  return undefined;
}

/**
 * The contribution kinds `source` declares: each genuine
 * `defineServerContribution(…)` call (comments and strings masked) whose first
 * argument is a string literal. A call whose name is not a literal (the
 * function's own declaration) declares nothing a contribution can stamp.
 *
 * `companions` is read from the inline options literal only, and THROWS on
 * anything it cannot act on — a value other than the literal `true`, a kind
 * whose name is not a literal, a token bound to no `const` — because the
 * closure engine ships a companion by this reading alone: one it cannot read
 * would leave the companion an opt-in option, missing from the bundles that
 * need it. `file` names the source in those errors.
 */
export function parseServerContributionDeclarations(
  source: string,
  file = "<source>",
): ServerContributionKindDecl[] {
  const out: ServerContributionKindDecl[] = [];
  if (!source.includes("defineServerContribution")) return out;
  const masked = maskSource(source);
  for (const span of markerCallSpans(masked, "defineServerContribution")) {
    const where = `${file}:${lineAt(source, span.identifier)}`;
    // The function's own declaration (and its overloads) matches the marker
    // too; it declares no kind.
    if (/\bfunction\s+$/.test(masked.slice(0, span.identifier))) continue;
    // Depth-1 option object: the first `{` at the call's own top level.
    let depth = 0;
    let options: number | undefined;
    for (let i = span.open + 1; i < span.close; i++) {
      const c = masked[i]!;
      if (c === "{" && depth === 0) {
        options = i;
        break;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
    }
    const companionsAt =
      options === undefined
        ? undefined
        : topLevelFieldAt(masked, options, "companions");
    const companions = companionsAt !== undefined;
    if (companions && !/^true\b/.test(masked.slice(companionsAt))) {
      throw new Error(
        `${where}: a contribution kind's \`companions\` option must be the literal \`true\` — ` +
          "the closure engine reads it statically to ship the kind's companions with its declarer. " +
          `Got: ${source.slice(companionsAt, Math.min(span.close, companionsAt! + 60)).trim()}`,
      );
    }
    const kind = readStaticCallId(source, span);
    if (kind === null) {
      if (companions)
        throw new Error(
          `${where}: a contribution kind opened to companions must be named by a string literal.`,
        );
      continue;
    }
    const binding = BINDING_RE.exec(masked.slice(0, span.identifier))?.[1];
    if (companions && binding === undefined)
      throw new Error(
        `${where}: a contribution kind opened to companions must be bound to a \`const\` ` +
          `(\`export const X = defineServerContribution("${kind}", { companions: true })\`) — ` +
          "a companion names its kind by that binding.",
      );
    out.push({
      kind,
      ...(binding !== undefined ? { binding } : {}),
      absentOnHost:
        options !== undefined &&
        topLevelFieldAt(masked, options, "absentOnHost") !== undefined,
      companions,
    });
  }
  return out;
}
