import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-speech-synthesis
 *
 * `speechSynthesis` and `SpeechSynthesisUtterance` assume a browser that has
 * the Web Speech API. Some Android browsers, in-app webviews and
 * privacy-hardened builds have none ("speechSynthesis is not defined"). Speak
 * through `speechSupport()` from
 * `@plugins/primitives/plugins/dom/plugins/speech-synthesis/web`, whose
 * `unsupported` arm has no `speak`.
 *
 * Flags a value read of either global — bare (`speechSynthesis.speak(…)`), or
 * as a member of `window` / `globalThis` / `self`. A type reference
 * (`u: SpeechSynthesisUtterance`) is not a use; a local binding of the same
 * name is not the global.
 */

const createRule = lintRuleCreator(import.meta.url);

const GLOBALS = new Set(["speechSynthesis", "SpeechSynthesisUtterance"]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);

function memberName(node: TSESTree.MemberExpression): string | null {
  const p = node.property;
  if (!node.computed) return p.type === "Identifier" ? p.name : null;
  return p.type === "Literal" && typeof p.value === "string" ? p.value : null;
}

export default createRule({
  name: "no-raw-speech-synthesis",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw speechSynthesis / SpeechSynthesisUtterance — speak through speechSupport() from " +
        "@plugins/primitives/plugins/dom/plugins/speech-synthesis/web, which is unsupported where the browser has no speech synthesis.",
    },
    schema: [],
    messages: {
      noRawSpeechSynthesis:
        "Raw {{name}} crashes where the browser has no Web Speech API (some Android browsers, in-app " +
        "webviews: 'speechSynthesis is not defined'). Use speechSupport() from " +
        "@plugins/primitives/plugins/dom/plugins/speech-synthesis/web and branch on its kind.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      MemberExpression(node: TSESTree.MemberExpression) {
        const name = memberName(node);
        if (name === null || !GLOBALS.has(name)) return;
        if (
          node.object.type !== "Identifier" ||
          !GLOBAL_OBJECTS.has(node.object.name)
        )
          return;
        context.report({
          node,
          messageId: "noRawSpeechSynthesis",
          data: { name },
        });
      },
      "Program:exit"(program: TSESTree.Program) {
        // The global's references: unresolved ones (no lib globals declared),
        // and those resolving to the lib's implicit variable (no definition
        // in the file). A local of the same name has a definition of its own.
        const scope = context.sourceCode.getScope(program);
        const refs = scope.through.filter((r) =>
          GLOBALS.has(r.identifier.name),
        );
        for (const name of GLOBALS) {
          const lib = scope.set.get(name);
          if (lib !== undefined && lib.defs.length === 0)
            refs.push(...lib.references);
        }
        for (const ref of refs) {
          if (!ref.isValueReference) continue;
          // `typeof SpeechSynthesisUtterance` in a type reads no value at runtime.
          if (ref.identifier.parent?.type === "TSTypeQuery") continue;
          context.report({
            node: ref.identifier,
            messageId: "noRawSpeechSynthesis",
            data: { name: ref.identifier.name },
          });
        }
      },
    };
  },
});
