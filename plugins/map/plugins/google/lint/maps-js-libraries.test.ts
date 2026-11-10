import rule from "./maps-js-libraries";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });
const FILE = "/repo/plugins/foo/web/components/map.tsx";

ruleTester.run("maps-js-libraries", rule, {
  valid: [
    { code: `const maps = useMapsLibrary("maps");`, filename: FILE },
    { code: `await google.maps.importLibrary("marker");`, filename: FILE },
    {
      code: `const x = <APIProvider apiKey={k} libraries={["maps", "marker"]} />;`,
      filename: FILE,
    },
    { code: `const x = <APIProvider apiKey={k} />;`, filename: FILE },
  ],
  invalid: [
    {
      code: `const p = useMapsLibrary("places");`,
      filename: FILE,
      errors: [{ messageId: "library" }],
    },
    {
      code: `await google.maps.importLibrary("geocoding");`,
      filename: FILE,
      errors: [{ messageId: "library" }],
    },
    {
      code: `const p = useMapsLibrary(name);`,
      filename: FILE,
      errors: [{ messageId: "dynamic" }],
    },
    {
      code: `const x = <APIProvider apiKey={k} libraries={["maps", "places"]} />;`,
      filename: FILE,
      errors: [{ messageId: "library" }],
    },
    {
      code: `const x = <APIProvider apiKey={k} libraries={LIBS} />;`,
      filename: FILE,
      errors: [{ messageId: "dynamic" }],
    },
  ],
});
