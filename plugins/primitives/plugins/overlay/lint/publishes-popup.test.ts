/**
 * Tests for `publishes-popup`: a module importing a popup root primitive must
 * publish its open state.
 */

import rule from "./publishes-popup";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

const FILE = "/repo/plugins/foo/web/components/view.tsx";

ruleTester.run("publishes-popup", rule, {
  valid: [
    {
      code: `import { Dialog as P } from "@base-ui/react/dialog";
function D(props) { const m = usePopupOpenMirror(props); return <P.Root {...m} />; }`,
      filename: FILE,
    },
    {
      code: `import { Menu } from "@base-ui/react/menu";
function M({ open }) { usePublishOpenPopup(open); return <Menu.Root open={open} />; }`,
      filename: FILE,
    },
    // Not popups the user works in.
    {
      code: `import { Tooltip } from "@base-ui/react/tooltip";`,
      filename: FILE,
    },
    { code: `import { Button } from "@base-ui/react/button";`, filename: FILE },
    // A type-only import renders nothing.
    {
      code: `import type { Dialog } from "@base-ui/react/dialog";`,
      filename: FILE,
    },
    // ui-kit's wrappers are the way.
    {
      code: `import { Dialog } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";`,
      filename: FILE,
    },
  ],
  invalid: [
    {
      code: `import { Dialog as P } from "@base-ui/react/dialog";
function D(props) { return <P.Root {...props} />; }`,
      filename: FILE,
      errors: [{ messageId: "unpublished" }],
    },
    {
      code: `import { Popover } from "@base-ui/react/popover";
import { Select } from "@base-ui/react/select";`,
      filename: FILE,
      errors: [{ messageId: "unpublished" }, { messageId: "unpublished" }],
    },
  ],
});
