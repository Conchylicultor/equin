import rule from "./no-raw-speech-synthesis";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const FILE = "/repo/plugins/foo/web/components/x.tsx";

ruleTester.run("no-raw-speech-synthesis", rule, {
  valid: [
    {
      code: `const s = speechSupport(); if (s.kind === "supported") s.speak("A");`,
      filename: FILE,
    },
    {
      code: `function f(u: SpeechSynthesisUtterance) { return u.text; }`,
      filename: FILE,
    },
    {
      code: `function f(speechSynthesis: { cancel(): void }) { speechSynthesis.cancel(); }`,
      filename: FILE,
    },
    { code: `const x = obj.speechSynthesis;`, filename: FILE },
    { code: `type U = typeof SpeechSynthesisUtterance;`, filename: FILE },
  ],
  invalid: [
    {
      code: `speechSynthesis.cancel();`,
      filename: FILE,
      errors: [{ messageId: "noRawSpeechSynthesis" }],
    },
    {
      code: `const u = new SpeechSynthesisUtterance("A");`,
      filename: FILE,
      errors: [{ messageId: "noRawSpeechSynthesis" }],
    },
    {
      code: `window.speechSynthesis.speak(u);`,
      filename: FILE,
      errors: [{ messageId: "noRawSpeechSynthesis" }],
    },
    {
      code: `globalThis["speechSynthesis"].cancel();`,
      filename: FILE,
      errors: [{ messageId: "noRawSpeechSynthesis" }],
    },
  ],
});

// As the repo lints: lib.dom's globals declared, so a bare `speechSynthesis`
// resolves to the lib's implicit variable instead of staying unresolved.
const DOM = { parserOptions: { lib: ["dom", "esnext"] } };

ruleTester.run("no-raw-speech-synthesis (lib.dom globals)", rule, {
  valid: [
    {
      code: `type U = typeof SpeechSynthesisUtterance; function f(u: SpeechSynthesisUtterance) { return u.text; }`,
      filename: FILE,
      languageOptions: DOM,
    },
    {
      code: `function f(speechSynthesis: { cancel(): void }) { speechSynthesis.cancel(); }`,
      filename: FILE,
      languageOptions: DOM,
    },
  ],
  invalid: [
    {
      code: `speechSynthesis.speak = (u: SpeechSynthesisUtterance) => { void u; };`,
      filename: FILE,
      languageOptions: DOM,
      errors: [{ messageId: "noRawSpeechSynthesis" }],
    },
    {
      code: `const u = new SpeechSynthesisUtterance("A");`,
      filename: FILE,
      languageOptions: DOM,
      errors: [{ messageId: "noRawSpeechSynthesis" }],
    },
  ],
});
