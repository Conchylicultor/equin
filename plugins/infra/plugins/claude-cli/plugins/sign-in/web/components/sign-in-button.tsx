import {
  Button,
  ButtonGroup,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { CLAUDE_SIGN_IN_METHODS, type ClaudeSignInMethod } from "../../core";

const chevronIcon = symbol("keyboard-arrow-down");

const METHODS = Object.keys(CLAUDE_SIGN_IN_METHODS) as ClaudeSignInMethod[];

/**
 * Sign in, as a split button: the main half signs in with a Claude
 * subscription (the common case), the chevron offers every way Claude Code
 * signs in — each with what it is for.
 */
export function ClaudeSignInButton({
  onSignIn,
}: {
  onSignIn: (method: ClaudeSignInMethod) => Promise<void>;
}) {
  return (
    <ButtonGroup>
      <Button onClick={() => onSignIn("claudeai")}>Sign in</Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button aspect="icon" aria-label="Other ways to sign in" />}
        >
          <Icon icon={chevronIcon} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {METHODS.map((method) => (
            <DropdownMenuItem
              key={method}
              onClick={() => {
                void onSignIn(method);
              }}
            >
              <Stack gap="none">
                <Text>{CLAUDE_SIGN_IN_METHODS[method].label}</Text>
                <Text variant="caption" tone="muted">
                  {CLAUDE_SIGN_IN_METHODS[method].hint}
                </Text>
              </Stack>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
