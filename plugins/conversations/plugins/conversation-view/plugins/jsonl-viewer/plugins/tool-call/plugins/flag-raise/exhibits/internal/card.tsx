import { FlagRaiseToolView } from "../../web/components/flag-raise-tool-view";

/**
 * A flag with three items — two carrying a detail folded under them, one
 * without — and notes belonging to no one item.
 */
export default function FlagRaiseCardExhibit() {
  return (
    <FlagRaiseToolView
      event={{
        kind: "tool-call",
        at: "2026-11-13T05:00:00.000Z",
        toolUseId: "toolu_exhibit",
        name: "mcp__equin__flag_raise",
      }}
      input={{
        items: [
          {
            category: "bug",
            text: "Some database tests still fail, probably not from this change",
            detail:
              "13 in tasks-core (mandate, cluster and status suites) run against this worktree's real database; its stored triggers point at jobs the test process never registers.\n1 in spawn-dead-letter: the test's fake runtime has no subscribe.",
          },
          {
            category: "caveat",
            text: 'Automation launches now send a "Conversation started" notification',
            detail:
              "Launches from automations and the boot reconcile were silent before; every launch you are not looking at is now announced, except system conversations such as triage.",
          },
          {
            category: "decision",
            text: "Should old flags keep their generic category?",
          },
        ],
        details:
          "The design doc is research/2026-11-13-conversations-typed-launch-cause.md.",
      }}
    />
  );
}
