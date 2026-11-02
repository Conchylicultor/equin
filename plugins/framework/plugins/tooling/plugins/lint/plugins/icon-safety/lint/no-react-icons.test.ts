/**
 * Tests for the icon-safety rules: `no-react-icons` bans every react-icons
 * import, the icon picker included, and `no-robot-icon` catches the robot
 * symbols.
 */

import noReactIcons from "./no-react-icons";
import noRobotIcon from "./no-robot-icon";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const PICKER =
  "/repo/plugins/primitives/plugins/icon-picker/web/components/icon-picker.tsx";
const ELSEWHERE = "/repo/plugins/tasks/web/components/task-row.tsx";

ruleTester.run("no-react-icons", noReactIcons, {
  valid: [
    {
      code: `import { symbol } from "@plugins/ui/plugins/icons/core";`,
      filename: ELSEWHERE,
    },
  ],
  invalid: [
    {
      code: `import { MdClose } from "react-icons/md";`,
      filename: PICKER,
      errors: [{ messageId: "reactIcons" }],
    },
    {
      code: `import { MdClose } from "react-icons/md";`,
      filename: ELSEWHERE,
      errors: [{ messageId: "reactIcons" }],
    },
    {
      code: `import type { IconType } from "react-icons";`,
      filename: ELSEWHERE,
      errors: [{ messageId: "reactIcons" }],
    },
    {
      code: `export { SiGithub } from "react-icons/si";`,
      filename: ELSEWHERE,
      errors: [{ messageId: "reactIcons" }],
    },
    {
      code: `const md = await import("react-icons/md");`,
      filename: ELSEWHERE,
      errors: [{ messageId: "reactIcons" }],
    },
  ],
});

ruleTester.run("no-robot-icon", noRobotIcon, {
  valid: [
    {
      code: `import { symbol } from "@plugins/ui/plugins/icons/core";\nconst i = symbol("auto-awesome");`,
    },
    // Not the icons core's marker.
    { code: `const i = symbol("smart-toy");` },
  ],
  invalid: [
    {
      code: `import { symbol } from "@plugins/ui/plugins/icons/core";\nconst i = symbol("smart-toy");`,
      errors: [{ messageId: "robotIcon" }],
    },
    {
      code: `import { symbol } from "@plugins/ui/plugins/icons/core";\nconst i = symbol("robot-2");`,
      errors: [{ messageId: "robotIcon" }],
    },
  ],
});
