import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  ClaudeCodeFix,
  ClaudeCodeFixButton,
} from "../../web/components/claude-code-fix";

export default function ClaudeCodeFixExhibit() {
  return (
    <Stack gap="md">
      <ClaudeCodeFix block={{ kind: "signed-out", version: "2.1.0" }} />
      <ClaudeCodeFix block={{ kind: "sign-in-refused", version: "2.1.0" }} />
      <Line>
        <ClaudeCodeFixButton block={{ kind: "signed-out", version: "2.1.0" }} />
      </Line>
    </Stack>
  );
}
